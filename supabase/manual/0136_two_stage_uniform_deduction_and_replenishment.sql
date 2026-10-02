-- Migration 0136: Two-stage uniform deduction and replenishment calculation
-- • 階段一：員工領取（即時發生）
--   • 人事單位：申請領用 +X
--   • 人事倉庫：發貨扣庫 -X
--   • （此時人事倉庫少 X 件，總倉庫存暫時不變）
-- • 階段二：月底總倉補貨（月底結算）
--   • 總倉：調撥出庫 -X
--   • 人事倉庫：調撥入庫 +X
--   • （此時人事倉庫補回 X 件，總倉實際減少 X 件）

begin;

-- 1. 放寬 inventory_balances 非負約束，允許人事倉庫先行發貨扣庫（待月底總倉補貨調撥入庫沖回）
alter table public.inventory_balances
  drop constraint if exists inventory_balances_on_hand_quantity_check;

-- 2. 確保 inventory_reservations 允許 0 數量
alter table public.inventory_reservations
  drop constraint if exists inventory_reservations_quantity_check;

alter table public.inventory_reservations
  add constraint inventory_reservations_quantity_check check (quantity >= 0);

-- 3. 解除 hr_request_items.requested_transfer_quantity 的 generated column 限制
do $$
begin
  alter table public.hr_request_items alter column requested_transfer_quantity drop expression;
exception when others then
  null;
end $$;

-- 4. Trigger on hr_request_items: 調庫需求僅為增庫量（員工領用由人事倉庫發貨扣庫，不向總倉調庫）
create or replace function public.calculate_hr_request_item_transfer_quantity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  -- 階段一：員工領用由人事倉發貨扣庫，總倉調庫需求僅為增庫量
  NEW.requested_transfer_quantity := coalesce(NEW.increase_quantity, 0);
  return NEW;
end;
$$;

drop trigger if exists trg_hr_request_items_transfer_quantity on public.hr_request_items;
create trigger trg_hr_request_items_transfer_quantity
before insert or update on public.hr_request_items
for each row
execute function public.calculate_hr_request_item_transfer_quantity();

-- 5. 更新理貨草稿生成函式：員工領用由人事倉庫發貨，總倉調庫量僅為增庫量
create or replace function public.create_warehouse_shipment_draft(
  p_shipment_no text,
  p_hr_request_id uuid,
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
  request_row public.hr_requests;
  shipment_row public.warehouse_shipments;
  item_row record;
  general_warehouse_id uuid;
  hr_warehouse_id uuid;
  general_on_hand bigint;
  transfer_needed bigint;
  maximum_transfer bigint;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('WAREHOUSE') then
    raise exception using errcode = '42501', message = 'WAREHOUSE role is required';
  end if;
  if btrim(coalesce(p_shipment_no, '')) = '' or p_hr_request_id is null
     or btrim(coalesce(p_idempotency_key, '')) = '' or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'Shipment draft fields are invalid';
  end if;
  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('CREATE_WAREHOUSE_SHIPMENT_DRAFT', p_idempotency_key, p_request_fingerprint, current_account)
  on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'CREATE_WAREHOUSE_SHIPMENT_DRAFT' and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' and command_row.result_entity_id is not null then
      select * into shipment_row from public.warehouse_shipments where id = command_row.result_entity_id;
      return shipment_row;
    end if;
    raise exception using errcode = '40001', message = 'Shipment draft is already in progress or failed';
  end if;
  select * into request_row from public.hr_requests where id = p_hr_request_id for update;
  if request_row.id is null or request_row.status <> 'SUBMITTED' then raise exception 'Only SUBMITTED HR requests can be shipped'; end if;
  select id into general_warehouse_id from public.warehouses where purpose = 'GENERAL' and is_active;
  if general_warehouse_id is null then raise exception 'Active GENERAL warehouse is required'; end if;
  select id into hr_warehouse_id from public.warehouses where purpose = 'HR' and is_active;
  if hr_warehouse_id is null then raise exception 'Active HR warehouse is required'; end if;

  insert into public.warehouse_shipments (shipment_no, hr_request_id, created_by, source_request_row_version)
  values (left(btrim(p_shipment_no), 80), request_row.id, current_account, request_row.row_version)
  returning * into shipment_row;

  for item_row in
    select r.id as request_item_id, r.item_id, r.issue_quantity, r.increase_quantity, r.requested_transfer_quantity, r.item_code_snapshot, r.item_name_snapshot, r.unit_snapshot
    from public.hr_request_items r where r.request_id = request_row.id order by r.item_id
  loop
    select coalesce((select b.on_hand_quantity from public.inventory_balances b
      where b.warehouse_id = general_warehouse_id and b.item_id = item_row.item_id), 0)
      into general_on_hand;

    -- 階段一：員工領用由人事倉庫發貨扣庫，向總倉調庫量僅為增庫量
    transfer_needed := coalesce(item_row.increase_quantity, 0);
    maximum_transfer := least(transfer_needed, general_on_hand);

    insert into public.warehouse_shipment_lines (
      shipment_id, hr_request_id, hr_request_item_id, item_id,
      requested_transfer_quantity_snapshot, general_on_hand_snapshot,
      maximum_transfer_quantity_snapshot, actual_transfer_quantity
    ) values (
      shipment_row.id, request_row.id, item_row.request_item_id, item_row.item_id,
      transfer_needed, general_on_hand,
      maximum_transfer,
      maximum_transfer
    );
  end loop;
  update public.operation_commands set status = 'SUCCEEDED', result_entity_type = 'warehouse_shipments', result_entity_id = shipment_row.id, succeeded_at = now() where id = command_row.id;
  return shipment_row;
end;
$$;

revoke all on function public.create_warehouse_shipment_draft(text, uuid, text, text) from public, anon;
grant execute on function public.create_warehouse_shipment_draft(text, uuid, text, text) to authenticated;

-- 6. 更新發貨過帳函式：階段一員工領用直接扣除人事倉庫，總倉僅扣實際調撥量（無增庫時扣 0，總倉不變）
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

    -- 階段一：員工領用由人事倉庫發貨扣庫，向總倉調庫量僅為增庫量
    transfer_needed := coalesce(item_row.increase_quantity, 0);
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
    select p.id, line_no, hr_warehouse_id, item_row.item_id, 'HR_ISSUE_AND_REPLENISH', actual_transfer - item_row.issue_quantity, request_row.distribution_date
    from public.inventory_postings p where p.idempotency_key = p_idempotency_key;
  end loop;

  for item_row in
    select ri.* from public.hr_request_items ri
    where ri.request_id = request_row.id order by ri.item_id
  loop
    select sl.actual_transfer_quantity into actual_transfer
    from public.warehouse_shipment_lines sl
    where sl.shipment_id = p_shipment_id and sl.hr_request_item_id = item_row.id;

    -- 總倉僅扣除實際調撥量（無增庫調撥時 actual_transfer 為 0，總倉不變！）
    update public.inventory_balances
    set on_hand_quantity = on_hand_quantity - actual_transfer,
        version = version + 1,
        last_posting_id = (select id from public.inventory_postings where idempotency_key = p_idempotency_key),
        updated_at = now()
    where warehouse_id = general_warehouse_id and item_id = item_row.item_id;

    -- 階段一：人事倉庫發貨扣庫（扣除員工領用數量 issue_quantity，補入 actual_transfer）
    update public.inventory_balances
    set on_hand_quantity = on_hand_quantity + actual_transfer - item_row.issue_quantity,
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

revoke all on function public.post_warehouse_shipment(uuid, text, text) from public, anon;
grant execute on function public.post_warehouse_shipment(uuid, text, text) to authenticated;

commit;
