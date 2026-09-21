-- Server-side recapture keeps the current balance snapshot and the recount
-- confirmation in one database round trip. The existing update RPC remains
-- the single write authority and keeps its item/version fencing.

create or replace function public.recapture_stocktake_draft(
  p_stocktake_id uuid,
  p_note text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  stocktake_row public.stocktakes;
  line_ids uuid[];
  recount_lines jsonb;
  updated_stocktake public.stocktakes;
  result_lines jsonb;
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
     or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'Stocktake recapture fields are invalid';
  end if;

  select * into stocktake_row
  from public.stocktakes
  where id = p_stocktake_id and created_by = current_account;
  if stocktake_row.id is null then
    raise exception 'Stocktake draft does not exist';
  end if;

  -- Check the write authority's command first so an uncertain response can
  -- safely replay the already-succeeded result after the draft is DRAFT again.
  select * into command_row
  from public.operation_commands
  where operation_code = 'UPDATE_STOCKTAKE_DRAFT'
    and idempotency_key = p_idempotency_key
  for update;
  if command_row.id is not null then
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' and command_row.result_entity_id is not null then
      select * into updated_stocktake
      from public.stocktakes
      where id = command_row.result_entity_id;
      if updated_stocktake.id is null then
        raise exception 'Stocktake recapture result does not exist';
      end if;
    else
      raise exception using errcode = '40001', message = 'Stocktake recapture is already in progress or failed';
    end if;
  else
    if stocktake_row.status <> 'STALE_COUNT' then
      raise exception 'Only STALE_COUNT stocktakes can be recaptured';
    end if;

    select coalesce(array_agg(item_id order by item_id), '{}'::uuid[])
      into line_ids
    from public.stocktake_lines
    where stocktake_id = p_stocktake_id;
    if coalesce(array_length(line_ids, 1), 0) = 0 then
      raise exception 'A stocktake must contain at least one line';
    end if;

    insert into public.inventory_balances (warehouse_id, item_id)
    select stocktake_row.warehouse_id, item_id
    from unnest(line_ids) as requested(item_id)
    on conflict (warehouse_id, item_id) do nothing;

    -- The update RPC uses the same item-mutex -> stocktake lock order and
    -- re-reads the balances after locking. This preliminary lock prevents the
    -- server-side snapshot from being assembled across a concurrent inventory
    -- mutation while keeping the existing write authority unchanged.
    perform 1
  from public.inventory_balances balance_row
  where balance_row.warehouse_id = stocktake_row.warehouse_id
    and balance_row.item_id = any(line_ids)
  order by balance_row.item_id
  for update;

    select jsonb_agg(
      jsonb_build_object(
        'itemId', line_row.item_id,
        'countedQuantity', balance_row.on_hand_quantity,
        'reason', ''
      ) order by line_row.item_id
    ) into recount_lines
    from public.stocktake_lines line_row
    join public.inventory_balances balance_row
      on balance_row.warehouse_id = stocktake_row.warehouse_id
     and balance_row.item_id = line_row.item_id
    where line_row.stocktake_id = p_stocktake_id;

    updated_stocktake := public.update_stocktake_draft(
      p_stocktake_id,
      concat('RECOUNT_CONFIRMED:', btrim(coalesce(p_note, ''))),
      recount_lines,
      true,
      p_idempotency_key,
      p_request_fingerprint
    );
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', line_row.id,
      'item_id', line_row.item_id,
      'book_quantity_snapshot', line_row.book_quantity_snapshot,
      'balance_version_snapshot', line_row.balance_version_snapshot,
      'counted_quantity', line_row.counted_quantity,
      'reason', coalesce(line_row.reason, '')
    ) order by line_row.item_id
  ), '[]'::jsonb)
    into result_lines
  from public.stocktake_lines line_row
  where line_row.stocktake_id = p_stocktake_id;

  return jsonb_build_object(
    'stocktake', to_jsonb(updated_stocktake),
    'lines', result_lines
  );
end;
$$;

revoke all on function public.recapture_stocktake_draft(uuid, text, text, text) from public, anon;
grant execute on function public.recapture_stocktake_draft(uuid, text, text, text) to authenticated;
