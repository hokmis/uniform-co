-- Forward patch for databases that already applied 0025 before the p_recount signature was added.

drop function if exists public.update_stocktake_draft(uuid, text, jsonb, text, text);

create or replace function public.update_stocktake_draft(
  p_stocktake_id uuid,
  p_note text,
  p_lines jsonb,
  p_recount boolean,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.stocktakes
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  stocktake_row public.stocktakes;
  warehouse_row public.warehouses;
  line_value jsonb;
  item_id_row record;
  item_ids uuid[];
  line_count integer;
  counted_quantity bigint;
  book_quantity bigint;
  balance_version bigint;
  difference bigint;
begin
  current_account := private.current_account_id();
  if auth.uid() is null
     or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null
     or (not private.has_role('HR') and not private.has_role('WAREHOUSE')) then
    raise exception using errcode = '42501', message = 'HR or WAREHOUSE role is required';
  end if;
  if p_stocktake_id is null
     or btrim(coalesce(p_idempotency_key, '')) = ''
     or btrim(coalesce(p_request_fingerprint, '')) = ''
     or p_lines is null
     or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'Stocktake update fields are invalid';
  end if;
  line_count := jsonb_array_length(p_lines);
  if line_count = 0 or line_count > 1000 or pg_column_size(p_lines) > 10000000 then
    raise exception 'Stocktake update line limits exceeded';
  end if;
  for line_value in select value from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(line_value) <> 'object'
       or coalesce(line_value ->> 'itemId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or coalesce(line_value ->> 'countedQuantity', '') !~ '^[0-9][0-9]{0,17}$'
       or length(coalesce(line_value ->> 'reason', '')) > 500 then
      raise exception 'Invalid stocktake line';
    end if;
  end loop;
  if exists (
    select 1 from (
      select (value ->> 'itemId')::uuid as item_id from jsonb_array_elements(p_lines)
    ) requested group by item_id having count(*) > 1
  ) then
    raise exception 'A stocktake cannot contain the same item more than once';
  end if;

  insert into public.operation_commands (
    operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id
  ) values (
    'UPDATE_STOCKTAKE_DRAFT', p_idempotency_key, p_request_fingerprint, current_account
  ) on conflict (operation_code, idempotency_key) do nothing
  returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'UPDATE_STOCKTAKE_DRAFT' and idempotency_key = p_idempotency_key
    for update;
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' and command_row.result_entity_id is not null then
      select * into stocktake_row from public.stocktakes where id = command_row.result_entity_id;
      return stocktake_row;
    end if;
    raise exception using errcode = '40001', message = 'Stocktake update is already in progress or failed';
  end if;

  select * into stocktake_row from public.stocktakes
  where id = p_stocktake_id and created_by = current_account;
  if stocktake_row.id is null then raise exception 'Stocktake draft does not exist'; end if;
  if stocktake_row.status not in ('DRAFT', 'STALE_COUNT') then
    raise exception 'Only DRAFT or STALE_COUNT stocktakes can be updated';
  end if;
  if stocktake_row.status = 'STALE_COUNT' and not coalesce(p_recount, false) then
    raise exception using errcode = '40001', message = 'STALE_COUNT requires a fresh recapture and recount';
  end if;
  if stocktake_row.status = 'STALE_COUNT' and coalesce(p_recount, false) and btrim(coalesce(p_note, '')) not like 'RECOUNT_CONFIRMED:%' then
    raise exception using errcode = '40001', message = 'A fresh recount confirmation is required';
  end if;
  select * into warehouse_row from public.warehouses
  where id = stocktake_row.warehouse_id and is_active;
  if (warehouse_row.purpose = 'HR' and not private.has_role('HR'))
     or (warehouse_row.purpose = 'GENERAL' and not private.has_role('WAREHOUSE')) then
    raise exception using errcode = '42501', message = 'The account cannot update this warehouse stocktake';
  end if;

  select coalesce(array_agg(item_id order by item_id), '{}'::uuid[])
    into item_ids
  from (
    select distinct (value ->> 'itemId')::uuid as item_id from jsonb_array_elements(p_lines)
  ) requested;
  insert into public.inventory_item_locks (item_id)
  select item_id from unnest(item_ids) as requested(item_id) order by item_id
  on conflict (item_id) do nothing;
  for item_id_row in
    select item_id from unnest(item_ids) as requested(item_id) order by item_id
  loop
    perform 1 from public.inventory_item_locks where item_id = item_id_row.item_id for update;
  end loop;
  -- POST uses the same item-mutex -> stocktake lock order. Re-read after both
  -- locks so a concurrent POST cannot move the draft while it is being edited.
  select * into stocktake_row from public.stocktakes where id = p_stocktake_id for update;
  if stocktake_row.status not in ('DRAFT', 'STALE_COUNT') then
    raise exception using errcode = '40001', message = 'Stocktake changed while locking; retry';
  end if;
  delete from public.stocktake_lines where stocktake_id = p_stocktake_id;
  for line_value in select value from jsonb_array_elements(p_lines) loop
    if not exists (
      select 1 from public.uniform_items where id = (line_value ->> 'itemId')::uuid and is_active
    ) then
      raise exception 'Active uniform item does not exist';
    end if;
    insert into public.inventory_balances (warehouse_id, item_id)
    values (stocktake_row.warehouse_id, (line_value ->> 'itemId')::uuid)
    on conflict (warehouse_id, item_id) do nothing;
    perform 1 from public.inventory_balances b
    where b.warehouse_id = stocktake_row.warehouse_id
      and b.item_id = (line_value ->> 'itemId')::uuid
    for update;
    select b.on_hand_quantity, b.version into book_quantity, balance_version
    from public.inventory_balances b
    where b.warehouse_id = stocktake_row.warehouse_id
      and b.item_id = (line_value ->> 'itemId')::uuid;
    counted_quantity := (line_value ->> 'countedQuantity')::bigint;
    if stocktake_row.status = 'STALE_COUNT' and (not coalesce(p_recount, false) or counted_quantity <> book_quantity) then
      raise exception using errcode = '40001', message = 'STALE_COUNT requires a fresh recapture and recount';
    end if;
    difference := counted_quantity - book_quantity;
    if difference <> 0 and btrim(coalesce(line_value ->> 'reason', '')) = '' then
      raise exception 'A reason is required for a stocktake difference';
    end if;
    insert into public.stocktake_lines (
      stocktake_id, item_id, book_quantity_snapshot, balance_version_snapshot,
      counted_quantity, counted_at, reason
    ) values (
      p_stocktake_id, (line_value ->> 'itemId')::uuid, book_quantity, balance_version,
      counted_quantity, now(), nullif(btrim(line_value ->> 'reason'), '')
    );
  end loop;
  update public.stocktakes
  set status = 'DRAFT', stale_at = null, stale_reason = null,
      counted_at = now(), note = left(nullif(btrim(regexp_replace(coalesce(p_note, ''), '^RECOUNT_CONFIRMED:', '')), ''), 2000)
  where id = p_stocktake_id
  returning * into stocktake_row;
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'stocktakes',
      result_entity_id = p_stocktake_id, succeeded_at = now()
  where id = command_row.id;
  return stocktake_row;
end;
$$;


revoke all on function public.update_stocktake_draft(uuid, text, jsonb, boolean, text, text) from public, anon;
grant execute on function public.update_stocktake_draft(uuid, text, jsonb, boolean, text, text) to authenticated;
