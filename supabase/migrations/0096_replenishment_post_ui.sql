-- Connect submitted replenishment requests to the warehouse POST UI.
-- The browser must not mutate submitted replenishment lines directly. This
-- RPC receives the operator's requested quantities and performs the final
-- stock/reason validation while holding the same item and balance locks as
-- the existing replenishment posting path.

create or replace function private.prevent_posted_replenishment_line_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  if exists (
       select 1
       from public.replenishment_requests r
       where r.id = old.request_id
         and r.status in ('SUBMITTED', 'SHIPPED', 'CANCELLED')
     )
     and coalesce(current_setting('private.replenishment_post_context', true), '') <> 'on' then
    raise exception 'Submitted or posted replenishment lines are immutable';
  end if;
  if tg_op = 'UPDATE' and old.request_id <> new.request_id then
    raise exception 'A replenishment line cannot be moved to another request';
  end if;
  return new;
end;
$$;

create or replace function private.prevent_posted_replenishment_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  if old.status in ('SUBMITTED', 'SHIPPED', 'CANCELLED')
     and coalesce(current_setting('private.replenishment_post_context', true), '') <> 'on' then
    raise exception 'Submitted or posted replenishment requests are immutable';
  end if;
  return new;
end;
$$;

create or replace function public.post_replenishment_request_with_lines(
  p_request_id uuid,
  p_transfer_lines jsonb,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.replenishment_requests
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  request_row public.replenishment_requests;
  item_row record;
  item_id_row record;
  line_value jsonb;
  item_ids uuid[];
  current_item_ids uuid[];
  hr_warehouse_id uuid;
  general_warehouse_id uuid;
  general_on_hand bigint;
  maximum_transfer bigint;
  actual_transfer bigint;
  requested_line_count integer;
  current_line_count integer;
  line_no integer := 0;
  short_ship_reason text;
  result_row public.replenishment_requests;
  posting_id uuid;
begin
  current_account := private.current_account_id();
  if auth.uid() is null
     or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null
     or not private.has_role('WAREHOUSE') then
    raise exception using errcode = '42501', message = 'WAREHOUSE role is required';
  end if;
  if p_request_id is null
     or jsonb_typeof(p_transfer_lines) <> 'array'
     or jsonb_array_length(p_transfer_lines) = 0
     or jsonb_array_length(p_transfer_lines) > 1000
     or pg_column_size(p_transfer_lines) > 10000000
     or btrim(coalesce(p_idempotency_key, '')) = ''
     or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'Replenishment POST fields are invalid';
  end if;

  for line_value in select value from jsonb_array_elements(p_transfer_lines) loop
    if jsonb_typeof(line_value) <> 'object'
       or btrim(coalesce(line_value ->> 'lineId', '')) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or coalesce(line_value ->> 'actualTransferQuantity', '') !~ '^[0-9][0-9]{0,17}$' then
      raise exception 'Invalid replenishment transfer line';
    end if;
  end loop;

  select count(*) into requested_line_count from jsonb_array_elements(p_transfer_lines);
  select count(distinct value ->> 'lineId') into current_line_count from jsonb_array_elements(p_transfer_lines) as input(value);
  if requested_line_count <> current_line_count then
    raise exception 'Replenishment transfer lines cannot contain duplicates';
  end if;

  insert into public.operation_commands (
    operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id
  ) values (
    'POST_REPLENISHMENT_REQUEST', p_idempotency_key, p_request_fingerprint, current_account
  ) on conflict (operation_code, idempotency_key) do nothing
  returning * into command_row;
  if command_row.id is null then
    select * into command_row
    from public.operation_commands
    where operation_code = 'POST_REPLENISHMENT_REQUEST'
      and idempotency_key = p_idempotency_key
    for update;
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' and command_row.result_entity_id = p_request_id then
      select * into result_row from public.replenishment_requests where id = p_request_id;
      return result_row;
    end if;
    raise exception using errcode = '40001', message = 'replenishment POST is already in progress or failed';
  end if;

  select * into request_row
  from public.replenishment_requests
  where id = p_request_id
  for update;
  if request_row.id is null then
    raise exception 'Replenishment request does not exist';
  end if;
  if request_row.status <> 'SUBMITTED' then
    raise exception 'Only SUBMITTED replenishment requests can be posted';
  end if;

  select count(*) into current_line_count
  from public.replenishment_request_lines
  where request_id = p_request_id;
  if current_line_count <> requested_line_count
     or exists (
       select 1
       from public.replenishment_request_lines l
       where l.request_id = p_request_id
         and not exists (
           select 1 from jsonb_array_elements(p_transfer_lines) as input(value)
           where (input.value ->> 'lineId')::uuid = l.id
         )
     ) then
    raise exception using errcode = '40001', message = 'Replenishment lines changed; reload and retry';
  end if;

  select coalesce(array_agg(item_id order by item_id), '{}'::uuid[])
    into item_ids
  from (
    select distinct item_id from public.replenishment_request_lines where request_id = p_request_id
  ) requested_items;
  if cardinality(item_ids) = 0 then
    raise exception 'Replenishment request needs at least one item';
  end if;

  insert into public.inventory_item_locks (item_id)
  select item_id from unnest(item_ids) as requested(item_id) order by item_id
  on conflict (item_id) do nothing;
  for item_id_row in
    select item_id from unnest(item_ids) as requested(item_id) order by item_id
  loop
    perform 1 from public.inventory_item_locks where item_id = item_id_row.item_id for update;
  end loop;

  select coalesce(array_agg(item_id order by item_id), '{}'::uuid[])
    into current_item_ids
  from (
    select distinct item_id from public.replenishment_request_lines where request_id = p_request_id
  ) current_items;
  if current_item_ids is distinct from item_ids then
    raise exception using errcode = '40001', message = 'Replenishment item set changed while locking; retry';
  end if;

  select id into hr_warehouse_id from public.warehouses where purpose = 'HR' and is_active;
  select id into general_warehouse_id from public.warehouses where purpose = 'GENERAL' and is_active;
  if hr_warehouse_id is null or general_warehouse_id is null then
    raise exception 'Both active HR and GENERAL warehouses are required';
  end if;
  insert into public.inventory_balances (warehouse_id, item_id)
  select w.id, requested_item.item_id
  from (values (hr_warehouse_id), (general_warehouse_id)) as w(id),
       unnest(item_ids) as requested_item(item_id)
  on conflict (warehouse_id, item_id) do nothing;
  for item_id_row in
    select item_id from unnest(item_ids) as requested(item_id) order by item_id
  loop
    perform 1 from public.inventory_balances b
    where b.item_id = item_id_row.item_id
      and b.warehouse_id in (hr_warehouse_id, general_warehouse_id)
    order by b.item_id, b.warehouse_id for update;
  end loop;

  perform set_config('private.replenishment_post_context', 'on', true);
  for item_row in
    select l.* from public.replenishment_request_lines l
    where l.request_id = p_request_id order by l.item_id
  loop
    select b.on_hand_quantity into general_on_hand
    from public.inventory_balances b
    where b.warehouse_id = general_warehouse_id and b.item_id = item_row.item_id;
    maximum_transfer := least(item_row.requested_quantity, general_on_hand);
    select input.value into line_value
    from jsonb_array_elements(p_transfer_lines) as input(value)
    where (input.value ->> 'lineId')::uuid = item_row.id;
    actual_transfer := (line_value ->> 'actualTransferQuantity')::bigint;
    short_ship_reason := nullif(btrim(line_value ->> 'shortShipReasonCode'), '');
    if actual_transfer > maximum_transfer then
      raise exception 'Actual replenishment transfer exceeds GENERAL stock for item %', item_row.item_id;
    end if;
    if actual_transfer < maximum_transfer and not exists (
      select 1 from public.transfer_short_ship_reasons r
      where r.code = short_ship_reason and r.is_active
    ) then
      raise exception 'A short-ship reason is required for item %', item_row.item_id;
    end if;
    update public.replenishment_request_lines
    set request_row_version_snapshot = request_row.row_version,
        general_on_hand_snapshot = general_on_hand,
        maximum_transfer_quantity_snapshot = maximum_transfer,
        actual_transfer_quantity = actual_transfer,
        short_ship_reason_code = case when actual_transfer < maximum_transfer then short_ship_reason else null end
    where id = item_row.id;
  end loop;

  insert into public.inventory_postings (
    idempotency_key, posting_kind, source_entity_id, posted_by
  ) values (p_idempotency_key, 'REPLENISHMENT', p_request_id, current_account)
  returning id into posting_id;
  for item_row in
    select l.* from public.replenishment_request_lines l
    where l.request_id = p_request_id order by l.item_id
  loop
    line_no := line_no + 1;
    insert into public.inventory_ledger_entries
      (posting_id, line_no, warehouse_id, item_id, movement_kind, quantity_delta, occurred_on)
    values (posting_id, line_no, general_warehouse_id, item_row.item_id,
      'REPLENISHMENT_OUT', -item_row.actual_transfer_quantity, current_date);
    line_no := line_no + 1;
    insert into public.inventory_ledger_entries
      (posting_id, line_no, warehouse_id, item_id, movement_kind, quantity_delta, occurred_on)
    values (posting_id, line_no, hr_warehouse_id, item_row.item_id,
      'REPLENISHMENT_IN', item_row.actual_transfer_quantity, current_date);
    update public.inventory_balances
    set on_hand_quantity = on_hand_quantity - item_row.actual_transfer_quantity,
        version = version + 1, last_posting_id = posting_id, updated_at = now()
    where warehouse_id = general_warehouse_id and item_id = item_row.item_id;
    update public.inventory_balances
    set on_hand_quantity = on_hand_quantity + item_row.actual_transfer_quantity,
        version = version + 1, last_posting_id = posting_id, updated_at = now()
    where warehouse_id = hr_warehouse_id and item_id = item_row.item_id;
  end loop;

  update public.replenishment_requests
  set status = 'SHIPPED', shipped_at = now(), shipped_by = current_account,
      row_version = row_version + 1
  where id = p_request_id
  returning * into result_row;
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'replenishment_requests',
      result_entity_id = p_request_id, succeeded_at = now()
  where id = command_row.id;
  perform set_config('private.replenishment_post_context', 'off', true);
  return result_row;
end;
$$;

revoke all on function public.post_replenishment_request_with_lines(uuid, jsonb, text, text) from public, anon;
grant execute on function public.post_replenishment_request_with_lines(uuid, jsonb, text, text) to authenticated;

-- Keep the original three-argument RPC compatible for existing callers. It
-- uses the current GENERAL balance as the default transfer quantity, while
-- the UI uses the explicit four-argument RPC above.
create or replace function public.post_replenishment_request(
  p_request_id uuid,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.replenishment_requests
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  transfer_lines jsonb;
begin
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'lineId', source_line.id,
      'actualTransferQuantity', coalesce(
        source_line.actual_transfer_quantity,
        least(source_line.requested_quantity, source_line.general_on_hand)
      ),
      'shortShipReasonCode', source_line.short_ship_reason_code
    ) order by source_line.id
  ), '[]'::jsonb)
  into transfer_lines
  from (
    select l.id,
           l.requested_quantity,
           l.actual_transfer_quantity,
           l.short_ship_reason_code,
           coalesce(b.on_hand_quantity, 0)::bigint as general_on_hand
    from public.replenishment_request_lines l
    left join public.inventory_balances b
      on b.item_id = l.item_id
     and b.warehouse_id in (
       select w.id from public.warehouses w
       where w.purpose = 'GENERAL' and w.is_active
     )
    where l.request_id = p_request_id
  ) source_line;

  return public.post_replenishment_request_with_lines(
    p_request_id,
    transfer_lines,
    p_idempotency_key,
    p_request_fingerprint
  );
end;
$$;

revoke all on function public.post_replenishment_request(uuid, text, text) from public, anon;
grant execute on function public.post_replenishment_request(uuid, text, text) to authenticated;
