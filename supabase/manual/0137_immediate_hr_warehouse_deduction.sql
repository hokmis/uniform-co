-- Migration 0137: Immediate HR Warehouse Deduction upon Submission (Mode B)
-- • 階段一：人資送出需求單時（即時扣發）
--   • 立即扣除人事倉實體庫存：hr_warehouse -= issue_quantity
--   • 記錄人事倉發放流水：HR_ISSUE_OUT
--   • 方式 B：只要兩倉現有量合計足夠即可申請，人事倉允許暫時呈負數（借發預支）
--   • 總倉調庫需求量記錄為：issue_quantity + increase_quantity（待月底調撥補回）
-- • 階段二：倉庫月底發貨調撥（月結沖回）
--   • 總倉調出扣庫：general_warehouse -= actual_transfer
--   • 人事倉調入補回：hr_warehouse += actual_transfer（沖平人事倉平日發放的負數/扣除量）
--   • 人事倉不再重複扣除 issue_quantity！
-- • 例外處理：發貨前取消需求單時
--   • 自動將 issue_quantity 回補加回人事倉：hr_warehouse += issue_quantity

begin;

-- 1. 更新 hr_request_items 調庫需求量計算：發放量 + 增庫量
create or replace function public.calculate_hr_request_item_transfer_quantity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  -- 調庫需求為平日發放量（待月底調撥補回）加上額外增庫量
  NEW.requested_transfer_quantity := coalesce(NEW.issue_quantity, 0) + coalesce(NEW.increase_quantity, 0);
  return NEW;
end;
$$;

drop trigger if exists trg_hr_request_items_transfer_quantity on public.hr_request_items;
create trigger trg_hr_request_items_transfer_quantity
before insert or update on public.hr_request_items
for each row
execute function public.calculate_hr_request_item_transfer_quantity();

-- 2. 更新 submit_hr_request：送單時即時扣除人事倉庫存並記錄流水
create or replace function public.submit_hr_request(
  p_request_id uuid,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.hr_requests
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  request_row public.hr_requests;
  item_row record;
  locked_item_ids uuid[];
  current_item_ids uuid[];
  combined_on_hand bigint;
  active_reserved bigint;
  issue_sum integer;
  total_demand integer;
  item_id_row record;
  hr_warehouse_id uuid;
  general_warehouse_id uuid;
  posting_id uuid;
  ledger_line_no integer := 0;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('HR') then
    raise exception using errcode = '42501', message = 'HR role is required';
  end if;

  if p_request_id is null or btrim(coalesce(p_idempotency_key, '')) = ''
     or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'HR submission fields are invalid';
  end if;

  insert into public.operation_commands (
    operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id
  ) values (
    'SUBMIT_HR_REQUEST', p_idempotency_key, p_request_fingerprint, current_account
  ) on conflict (operation_code, idempotency_key) do nothing
  returning * into command_row;

  if command_row.id is null then
    select * into command_row
    from public.operation_commands
    where operation_code = 'SUBMIT_HR_REQUEST'
      and idempotency_key = p_idempotency_key
    for update;
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' and command_row.result_entity_id = p_request_id then
      select * into request_row from public.hr_requests where id = p_request_id;
      return request_row;
    end if;
    raise exception using errcode = '40001', message = 'request is already in progress or failed';
  end if;

  select id into hr_warehouse_id from public.warehouses where purpose = 'HR' and is_active;
  if hr_warehouse_id is null then raise exception 'Active HR warehouse is required'; end if;

  select id into general_warehouse_id from public.warehouses where purpose = 'GENERAL' and is_active;
  if general_warehouse_id is null then raise exception 'Active GENERAL warehouse is required'; end if;

  select coalesce(array_agg(item_id order by item_id), '{}'::uuid[])
    into locked_item_ids
  from (
    select distinct item_id
    from public.hr_request_items
    where request_id = p_request_id
  ) requested_items;
  if cardinality(locked_item_ids) = 0 then
    raise exception 'At least one request item is required';
  end if;

  insert into public.inventory_item_locks (item_id)
  select item_id
  from unnest(locked_item_ids) as requested(item_id)
  order by item_id
  on conflict (item_id) do nothing;

  for item_id_row in
    select item_id from unnest(locked_item_ids) as requested(item_id) order by item_id
  loop
    perform 1 from public.inventory_item_locks where item_id = item_id_row.item_id for update;
  end loop;

  select * into request_row
  from public.hr_requests
  where id = p_request_id
  for update;

  if request_row.id is null then
    raise exception 'HR request does not exist';
  end if;
  if request_row.created_by <> current_account then
    raise exception using errcode = '42501', message = 'Only the request owner can submit this draft';
  end if;
  if request_row.status <> 'DRAFT' then
    raise exception 'Only DRAFT requests can be submitted';
  end if;

  select coalesce(array_agg(item_id order by item_id), '{}'::uuid[])
    into current_item_ids
  from (
    select distinct item_id
    from public.hr_request_items
    where request_id = p_request_id
  ) current_items;
  if current_item_ids is distinct from locked_item_ids then
    raise exception using errcode = '40001', message = 'Request items changed while submission was locking; retry';
  end if;

  -- 建立扣庫 posting 紀錄
  insert into public.inventory_postings (
    idempotency_key, posting_kind, source_entity_id, posted_by
  ) values (
    p_idempotency_key, 'HR_ISSUE_OUT', p_request_id, current_account
  ) returning id into posting_id;

  for item_row in
    select * from public.hr_request_items where request_id = p_request_id order by item_id for update
  loop
    perform 1
    from public.inventory_balances balance_row
    join public.warehouses warehouse_row on warehouse_row.id = balance_row.warehouse_id
    where balance_row.item_id = item_row.item_id
      and warehouse_row.is_active
      and warehouse_row.purpose in ('HR', 'GENERAL')
    order by balance_row.warehouse_id
    for update;

    select coalesce(sum(balance_row.on_hand_quantity), 0)
      into combined_on_hand
    from public.inventory_balances balance_row
    join public.warehouses warehouse_row on warehouse_row.id = balance_row.warehouse_id
    where balance_row.item_id = item_row.item_id
      and warehouse_row.is_active
      and warehouse_row.purpose in ('HR', 'GENERAL');

    perform 1 from public.inventory_reservations reservation_row
    where reservation_row.item_id = item_row.item_id
      and reservation_row.status = 'ACTIVE'
    order by reservation_row.source_hr_request_id, reservation_row.id
    for update;

    select coalesce(sum(reservation_row.quantity), 0)
      into active_reserved
    from public.inventory_reservations reservation_row
    where reservation_row.item_id = item_row.item_id
      and reservation_row.status = 'ACTIVE';

    select coalesce(sum(issue_line.quantity), 0)
      into issue_sum
    from public.hr_issue_lines issue_line
    where issue_line.request_id = p_request_id
      and issue_line.item_id = item_row.item_id;

    if issue_sum <> item_row.issue_quantity then
      raise exception 'Issue summary does not match employee lines for item %', item_row.item_id;
    end if;

    total_demand := item_row.issue_quantity + coalesce(item_row.increase_quantity, 0);

    -- 方式 B：檢查兩倉合計量足以涵蓋總需求（允許人事倉預支）
    if total_demand > combined_on_hand - active_reserved then
      raise exception 'Requested quantity exceeds available combined stock for item %', item_row.item_id;
    end if;

    -- 【關鍵變更 1】：送單即時扣除人事倉實體庫存
    if item_row.issue_quantity > 0 then
      update public.inventory_balances
      set on_hand_quantity = on_hand_quantity - item_row.issue_quantity,
          version = version + 1,
          last_posting_id = posting_id,
          updated_at = now()
      where warehouse_id = hr_warehouse_id and item_id = item_row.item_id;

      ledger_line_no := ledger_line_no + 1;
      insert into public.inventory_ledger_entries (
        posting_id, line_no, warehouse_id, item_id, movement_kind, quantity_delta, occurred_on
      ) values (
        posting_id, ledger_line_no, hr_warehouse_id, item_row.item_id, 'HR_ISSUE_OUT', -item_row.issue_quantity, request_row.distribution_date
      );
    end if;

    -- 【關鍵變更 2】：發放量已在人事倉現有量扣除，預留僅針對增庫量建立
    if coalesce(item_row.increase_quantity, 0) > 0 then
      insert into public.inventory_reservations (source_hr_request_id, item_id, quantity)
      values (p_request_id, item_row.item_id, item_row.increase_quantity);
    end if;
  end loop;

  update public.hr_requests
  set status = 'SUBMITTED',
      submitted_at = now(),
      submitted_by = current_account,
      row_version = row_version + 1
  where id = p_request_id
  returning * into request_row;

  update public.operation_commands
  set status = 'SUCCEEDED',
      result_entity_type = 'hr_requests',
      result_entity_id = request_row.id,
      succeeded_at = now()
  where id = command_row.id;

  return request_row;
end;
$$;

-- 3. 更新 cancel_hr_request：若取消需求單，將已扣之人事倉庫存沖回加回
create or replace function public.cancel_hr_request(
  p_request_id uuid,
  p_reason text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.hr_requests
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  request_row public.hr_requests;
  item_id_row record;
  item_row record;
  item_ids uuid[];
  hr_warehouse_id uuid;
  posting_id uuid;
  ledger_line_no integer := 0;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('HR') then
    raise exception using errcode = '42501', message = 'HR role is required';
  end if;
  if p_request_id is null or btrim(coalesce(p_reason, '')) = ''
     or btrim(coalesce(p_idempotency_key, '')) = ''
     or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'HR cancellation fields are invalid';
  end if;

  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('CANCEL_HR_REQUEST', p_idempotency_key, p_request_fingerprint, current_account)
  on conflict (operation_code, idempotency_key) do nothing returning * into command_row;

  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'CANCEL_HR_REQUEST' and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' then
      select * into request_row from public.hr_requests where id = command_row.result_entity_id;
      return request_row;
    end if;
    raise exception using errcode = '40001', message = 'HR cancellation is already in progress or failed';
  end if;

  select id into hr_warehouse_id from public.warehouses where purpose = 'HR' and is_active;

  select coalesce(array_agg(item_id order by item_id), '{}'::uuid[])
    into item_ids from (select distinct item_id from public.hr_request_items where request_id = p_request_id) requested_items;

  insert into public.inventory_item_locks (item_id)
  select item_id from unnest(item_ids) as requested(item_id) order by item_id on conflict (item_id) do nothing;

  for item_id_row in select item_id from unnest(item_ids) as requested(item_id) order by item_id loop
    perform 1 from public.inventory_item_locks where item_id = item_id_row.item_id for update;
  end loop;

  select * into request_row from public.hr_requests where id = p_request_id for update;
  if request_row.id is null then raise exception 'HR request does not exist'; end if;
  if request_row.status not in ('DRAFT', 'SUBMITTED', 'INVENTORY_REVIEW_REQUIRED') then
    raise exception 'Only pre-shipment HR requests can be cancelled';
  end if;

  -- 若該需求單已是 SUBMITTED，表示送單時已先扣過人事倉，取消時需回補沖回！
  if request_row.status in ('SUBMITTED', 'INVENTORY_REVIEW_REQUIRED') and hr_warehouse_id is not null then
    insert into public.inventory_postings (
      idempotency_key, posting_kind, source_entity_id, posted_by
    ) values (
      p_idempotency_key, 'HR_ISSUE_CANCEL_RESTORE', p_request_id, current_account
    ) returning id into posting_id;

    for item_row in select * from public.hr_request_items where request_id = p_request_id loop
      if item_row.issue_quantity > 0 then
        update public.inventory_balances
        set on_hand_quantity = on_hand_quantity + item_row.issue_quantity,
            version = version + 1,
            last_posting_id = posting_id,
            updated_at = now()
        where warehouse_id = hr_warehouse_id and item_id = item_row.item_id;

        ledger_line_no := ledger_line_no + 1;
        insert into public.inventory_ledger_entries (
          posting_id, line_no, warehouse_id, item_id, movement_kind, quantity_delta, occurred_on
        ) values (
          posting_id, ledger_line_no, hr_warehouse_id, item_row.item_id, 'HR_ISSUE_CANCEL_RESTORE', item_row.issue_quantity, current_date
        );
      end if;
    end loop;
  end if;

  update public.inventory_reservations
     set status = 'RELEASED', closed_at = now()
   where source_hr_request_id = p_request_id and status = 'ACTIVE';

  update public.hr_requests
     set status = 'CANCELLED', cancelled_at = now(), cancelled_by = current_account,
         cancellation_reason = left(btrim(p_reason), 2000), row_version = row_version + 1
   where id = p_request_id returning * into request_row;

  update public.operation_commands
     set status = 'SUCCEEDED', result_entity_type = 'hr_requests', result_entity_id = request_row.id, succeeded_at = now()
   where id = command_row.id;

  return request_row;
end;
$$;

-- 4. 更新 post_warehouse_shipment：發貨調撥過帳時，人事倉補入調撥量，不再扣除發放量
create or replace function public.post_warehouse_shipment(
  p_shipment_id uuid,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.warehouse_shipments
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  shipment_row public.warehouse_shipments;
  request_row public.hr_requests;
  line_row record;
  item_row record;
  item_id_row record;
  item_ids uuid[];
  general_warehouse_id uuid;
  hr_warehouse_id uuid;
  general_on_hand bigint;
  transfer_needed bigint;
  maximum_transfer bigint;
  actual_transfer bigint;
  other_reserved bigint;
  line_no integer := 0;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('WAREHOUSE') then
    raise exception using errcode = '42501', message = 'WAREHOUSE role is required';
  end if;
  if p_shipment_id is null or btrim(coalesce(p_idempotency_key, '')) = '' or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'Post shipment parameters are invalid';
  end if;
  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('POST_WAREHOUSE_SHIPMENT', p_idempotency_key, p_request_fingerprint, current_account)
  on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'POST_WAREHOUSE_SHIPMENT' and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' and command_row.result_entity_id is not null then
      select * into shipment_row from public.warehouse_shipments where id = command_row.result_entity_id;
      return shipment_row;
    end if;
    raise exception using errcode = '40001', message = 'Shipment posting is already in progress or failed';
  end if;

  select * into shipment_row from public.warehouse_shipments where id = p_shipment_id for update;
  if shipment_row.id is null then raise exception 'Shipment does not exist'; end if;
  if shipment_row.status = 'POSTED' then return shipment_row; end if;
  if shipment_row.status <> 'DRAFT' then raise exception 'Only DRAFT shipments can be posted'; end if;

  select * into request_row from public.hr_requests where id = shipment_row.hr_request_id for update;
  if request_row.id is null or request_row.status <> 'SUBMITTED' then
    raise exception 'Source HR request is not in SUBMITTED status';
  end if;
  if request_row.row_version <> shipment_row.source_request_row_version then
    raise exception 'Source HR request was updated after shipment draft was prepared';
  end if;

  select id into general_warehouse_id from public.warehouses where purpose = 'GENERAL' and is_active;
  if general_warehouse_id is null then raise exception 'Active GENERAL warehouse is required'; end if;
  select id into hr_warehouse_id from public.warehouses where purpose = 'HR' and is_active;
  if hr_warehouse_id is null then raise exception 'Active HR warehouse is required'; end if;

  select array_agg(ri.item_id order by ri.item_id) into item_ids
  from public.hr_request_items ri where ri.request_id = request_row.id;
  if item_ids is null or array_length(item_ids, 1) = 0 then
    raise exception 'HR request does not contain items';
  end if;

  insert into public.inventory_balances (warehouse_id, item_id, on_hand_quantity)
  select w.id, requested_item.item_id, 0
  from (values (hr_warehouse_id), (general_warehouse_id)) as w(id)
  cross join unnest(item_ids) as requested_item(item_id)
  on conflict (warehouse_id, item_id) do nothing;

  for item_id_row in select item_id from unnest(item_ids) as requested(item_id) order by item_id loop
    perform 1 from public.inventory_balances b
    where b.item_id = item_id_row.item_id and b.warehouse_id in (hr_warehouse_id, general_warehouse_id)
    order by b.item_id, b.warehouse_id for update;
  end loop;

  for item_id_row in select item_id from unnest(item_ids) as requested(item_id) order by item_id loop
    perform 1 from public.inventory_reservations r
    where r.item_id = item_id_row.item_id and r.status = 'ACTIVE'
    order by r.item_id, r.source_hr_request_id, r.id for update;
  end loop;

  for item_row in
    select ri.* from public.hr_request_items ri
    where ri.request_id = request_row.id order by ri.item_id
  loop
    select b.on_hand_quantity into general_on_hand
    from public.inventory_balances b where b.warehouse_id = general_warehouse_id and b.item_id = item_row.item_id;
    select coalesce(sum(r.quantity), 0) into other_reserved
    from public.inventory_reservations r
    where r.item_id = item_row.item_id and r.status = 'ACTIVE' and r.source_hr_request_id <> request_row.id;

    select sl.* into line_row
    from public.warehouse_shipment_lines sl
    where sl.shipment_id = p_shipment_id and sl.hr_request_item_id = item_row.id
    for update;
    if line_row.id is null or line_row.actual_transfer_quantity is null then
      raise exception 'Every shipment line needs an actual transfer quantity';
    end if;

    transfer_needed := coalesce(item_row.issue_quantity, 0) + coalesce(item_row.increase_quantity, 0);
    maximum_transfer := least(transfer_needed, general_on_hand);
    actual_transfer := least(line_row.actual_transfer_quantity, maximum_transfer);

    if actual_transfer < 0 then
      raise exception 'Actual transfer cannot be negative for item %', item_row.item_id;
    end if;
    if actual_transfer < maximum_transfer and not exists (
      select 1 from public.transfer_short_ship_reasons r
      where r.code = line_row.short_ship_reason_code and r.is_active
    ) then
      raise exception 'A short-ship reason is required for item %', item_row.item_id;
    end if;

    update public.warehouse_shipment_lines
    set hr_request_id = request_row.id,
        item_id = item_row.item_id,
        requested_transfer_quantity_snapshot = transfer_needed,
        general_on_hand_snapshot = general_on_hand,
        maximum_transfer_quantity_snapshot = maximum_transfer,
        actual_transfer_quantity = actual_transfer
    where id = line_row.id;
  end loop;

  insert into public.inventory_postings (
    idempotency_key, posting_kind, source_entity_id, posted_by
  ) values (
    p_idempotency_key, 'WAREHOUSE_SHIPMENT', p_shipment_id, current_account
  );

  for item_row in
    select ri.* from public.hr_request_items ri
    where ri.request_id = request_row.id order by ri.item_id
  loop
    select sl.actual_transfer_quantity into actual_transfer
    from public.warehouse_shipment_lines sl
    where sl.shipment_id = p_shipment_id and sl.hr_request_item_id = item_row.id;

    line_no := line_no + 1;
    insert into public.inventory_ledger_entries (
      posting_id, line_no, warehouse_id, item_id, movement_kind, quantity_delta, occurred_on
    )
    select p.id, line_no, general_warehouse_id, item_row.item_id, 'WAREHOUSE_SHIPMENT_OUT', -actual_transfer, request_row.distribution_date
    from public.inventory_postings p where p.idempotency_key = p_idempotency_key;

    line_no := line_no + 1;
    insert into public.inventory_ledger_entries (
      posting_id, line_no, warehouse_id, item_id, movement_kind, quantity_delta, occurred_on
    )
    select p.id, line_no, hr_warehouse_id, item_row.item_id, 'HR_REPLENISH_IN', actual_transfer, request_row.distribution_date
    from public.inventory_postings p where p.idempotency_key = p_idempotency_key;
  end loop;

  for item_row in
    select ri.* from public.hr_request_items ri
    where ri.request_id = request_row.id order by ri.item_id
  loop
    select sl.actual_transfer_quantity into actual_transfer
    from public.warehouse_shipment_lines sl
    where sl.shipment_id = p_shipment_id and sl.hr_request_item_id = item_row.id;

    -- 總倉扣除實際調撥量
    update public.inventory_balances
    set on_hand_quantity = on_hand_quantity - actual_transfer,
        version = version + 1,
        last_posting_id = (select id from public.inventory_postings where idempotency_key = p_idempotency_key),
        updated_at = now()
    where warehouse_id = general_warehouse_id and item_id = item_row.item_id;

    -- 人事倉調撥入庫補回（只增加 actual_transfer，發放量已在送單時扣除，不再二次扣發！）
    update public.inventory_balances
    set on_hand_quantity = on_hand_quantity + actual_transfer,
        version = version + 1,
        last_posting_id = (select id from public.inventory_postings where idempotency_key = p_idempotency_key),
        updated_at = now()
    where warehouse_id = hr_warehouse_id and item_id = item_row.item_id;

    update public.inventory_reservations
    set status = 'CLOSED', closed_at = now()
    where source_hr_request_id = request_row.id and item_id = item_row.item_id and status = 'ACTIVE';
  end loop;

  update public.hr_requests set status = 'POSTED', posted_at = now(), row_version = row_version + 1 where id = request_row.id;
  update public.warehouse_shipments set status = 'POSTED', posted_at = now() where id = p_shipment_id returning * into shipment_row;
  update public.operation_commands set status = 'SUCCEEDED', result_entity_type = 'warehouse_shipments', result_entity_id = p_shipment_id, succeeded_at = now() where id = command_row.id;

  return shipment_row;
end;
$$;

commit;
