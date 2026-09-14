-- Forward patch: apply the two-warehouse stocktake reservation conflict rules to already migrated projects.

create or replace function public.post_stocktake(
  p_stocktake_id uuid,
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
  line_row record;
  item_id_row record;
  item_ids uuid[];
  current_item_ids uuid[];
  warehouse_purpose text;
  hr_warehouse boolean;
  general_warehouse boolean;
  on_hand bigint;
  balance_version bigint;
  active_reserved bigint;
  combined_on_hand bigint;
  hr_warehouse_id uuid;
  general_warehouse_id uuid;
  difference bigint;
  posting_id uuid;
  line_no integer := 0;
  result_row public.stocktakes;
  conflict_request_id uuid;
begin
  current_account := private.current_account_id();
  if auth.uid() is null
     or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null then
    raise exception using errcode = '42501', message = 'An authenticated app account is required';
  end if;
  if btrim(coalesce(p_idempotency_key, '')) = ''
     or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'idempotency_key and request_fingerprint are required';
  end if;

  insert into public.operation_commands (
    operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id
  ) values (
    'POST_STOCKTAKE', p_idempotency_key, p_request_fingerprint, current_account
  ) on conflict (operation_code, idempotency_key) do nothing
  returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'POST_STOCKTAKE'
      and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' and command_row.result_entity_id = p_stocktake_id then
      select * into result_row from public.stocktakes where id = p_stocktake_id;
      return result_row;
    end if;
    raise exception using errcode = '40001', message = 'stocktake is already in progress or failed';
  end if;

  select coalesce(array_agg(item_id order by item_id), '{}'::uuid[])
    into item_ids
  from (
    select distinct item_id from public.stocktake_lines where stocktake_id = p_stocktake_id
  ) requested_items;
  if cardinality(item_ids) = 0 then
    raise exception 'Stocktake needs at least one item';
  end if;
  insert into public.inventory_item_locks (item_id)
  select item_id from unnest(item_ids) as requested(item_id) order by item_id
  on conflict (item_id) do nothing;
  for item_id_row in
    select item_id from unnest(item_ids) as requested(item_id) order by item_id
  loop
    perform 1 from public.inventory_item_locks where item_id = item_id_row.item_id for update;
  end loop;

  select * into stocktake_row from public.stocktakes
  where id = p_stocktake_id for update;
  if stocktake_row.id is null then
    raise exception 'Stocktake does not exist';
  end if;
  if stocktake_row.status = 'STALE_COUNT' then
    raise exception using errcode = '40001', message = 'Stocktake is stale; capture a new count before retrying';
  end if;
  if stocktake_row.status <> 'DRAFT' then
    raise exception 'Only DRAFT stocktakes can be posted';
  end if;

  select purpose into warehouse_purpose from public.warehouses where id = stocktake_row.warehouse_id;
  if warehouse_purpose is null then
    raise exception 'Stocktake warehouse does not exist';
  end if;
  hr_warehouse := warehouse_purpose = 'HR';
  general_warehouse := warehouse_purpose = 'GENERAL';
  if (hr_warehouse and not private.has_role('HR'))
     or (general_warehouse and not private.has_role('WAREHOUSE'))
     or (not hr_warehouse and not general_warehouse) then
    raise exception using errcode = '42501', message = 'The account cannot post this warehouse stocktake';
  end if;
  select id into hr_warehouse_id from public.warehouses where purpose = 'HR' and is_active;
  select id into general_warehouse_id from public.warehouses where purpose = 'GENERAL' and is_active;
  if hr_warehouse_id is null or general_warehouse_id is null then
    raise exception 'Both active HR and GENERAL warehouses are required';
  end if;

  select coalesce(array_agg(item_id order by item_id), '{}'::uuid[])
    into current_item_ids
  from (
    select distinct item_id from public.stocktake_lines where stocktake_id = p_stocktake_id
  ) current_items;
  if current_item_ids is distinct from item_ids then
    raise exception using errcode = '40001', message = 'Stocktake item set changed while locking; retry';
  end if;

  for item_id_row in
    select item_id from unnest(item_ids) as requested(item_id) order by item_id
  loop
    perform 1 from public.stocktake_lines
    where stocktake_id = p_stocktake_id and item_id = item_id_row.item_id for update;
  end loop;

  insert into public.inventory_balances (warehouse_id, item_id)
  select warehouse_row.id, item_id_row.item_id
  from (values (hr_warehouse_id), (general_warehouse_id)) as warehouse_row(id),
       unnest(item_ids) as item_id_row(item_id)
  on conflict (warehouse_id, item_id) do nothing;
  for item_id_row in
    select item_id from unnest(item_ids) as requested(item_id) order by item_id
  loop
    perform 1 from public.inventory_balances b
    where b.warehouse_id in (hr_warehouse_id, general_warehouse_id) and b.item_id = item_id_row.item_id
    order by b.item_id, b.warehouse_id for update;
  end loop;
  for item_id_row in
    select item_id from unnest(item_ids) as requested(item_id) order by item_id
  loop
    perform 1 from public.inventory_reservations r
    where r.item_id = item_id_row.item_id and r.status = 'ACTIVE'
    order by r.item_id, r.source_hr_request_id, r.id for update;
  end loop;

  for line_row in
    select l.* from public.stocktake_lines l
    where l.stocktake_id = p_stocktake_id order by l.item_id
  loop
    select b.on_hand_quantity, b.version
      into on_hand, balance_version
    from public.inventory_balances b
    where b.warehouse_id = stocktake_row.warehouse_id and b.item_id = line_row.item_id;
    if balance_version <> line_row.balance_version_snapshot
       or on_hand <> line_row.book_quantity_snapshot then
      update public.stocktakes
      set status = 'STALE_COUNT', stale_at = now(),
          stale_reason = '帳面版本已變更，必須重新取得帳面並實盤'
      where id = p_stocktake_id;
      update public.operation_commands
      set status = 'RETRYABLE_FAILED', result_entity_type = 'stocktakes',
          result_entity_id = p_stocktake_id, last_error_code = 'STALE_COUNT'
      where id = command_row.id;
      select * into result_row from public.stocktakes where id = p_stocktake_id;
      return result_row;
    end if;
    difference := line_row.counted_quantity - line_row.book_quantity_snapshot;
    if difference <> 0 and btrim(coalesce(line_row.reason, '')) = '' then
      raise exception 'A reason is required for stocktake differences';
    end if;
    select coalesce(sum(r.quantity), 0) into active_reserved
    from public.inventory_reservations r
    where r.item_id = line_row.item_id and r.status = 'ACTIVE';
    select coalesce(sum(b.on_hand_quantity), 0) into combined_on_hand
    from public.inventory_balances b
    where b.warehouse_id in (hr_warehouse_id, general_warehouse_id)
      and b.item_id = line_row.item_id;
    if combined_on_hand + difference < active_reserved then
      -- A real count that uncovers reservations is still posted, but all
      -- reservations belonging to affected requests are made unusable first.
      update public.inventory_reservations
      set status = 'CONFLICTED', closed_at = now()
      where item_id = line_row.item_id and status = 'ACTIVE';
      update public.inventory_reservations r
      set status = 'CONFLICTED', closed_at = now()
      where r.status = 'ACTIVE'
        and exists (
          select 1
          from public.inventory_reservations affected
          where affected.source_hr_request_id = r.source_hr_request_id
            and affected.item_id = line_row.item_id
            and affected.status = 'CONFLICTED'
        );
      update public.hr_requests r
      set status = 'INVENTORY_REVIEW_REQUIRED', row_version = r.row_version + 1
      where r.status = 'SUBMITTED'
        and exists (
          select 1 from public.inventory_reservations ir
          where ir.source_hr_request_id = r.id
            and ir.item_id = line_row.item_id
            and ir.status = 'CONFLICTED'
        );
    end if;
  end loop;

  insert into public.inventory_postings (
    idempotency_key, posting_kind, source_entity_id, posted_by
  ) values (p_idempotency_key, 'STOCKTAKE', p_stocktake_id, current_account)
  returning id into posting_id;
  for line_row in
    select l.* from public.stocktake_lines l
    where l.stocktake_id = p_stocktake_id order by l.item_id
  loop
    difference := line_row.counted_quantity - line_row.book_quantity_snapshot;
    line_no := line_no + 1;
    insert into public.inventory_ledger_entries
      (posting_id, line_no, warehouse_id, item_id, movement_kind, quantity_delta, occurred_on)
    values (posting_id, line_no, stocktake_row.warehouse_id, line_row.item_id,
      'STOCKTAKE_ADJUSTMENT', difference, current_date);
    update public.inventory_balances
    set on_hand_quantity = on_hand_quantity + difference,
        version = version + 1, last_posting_id = posting_id, updated_at = now()
    where warehouse_id = stocktake_row.warehouse_id and item_id = line_row.item_id;
  end loop;
  update public.stocktakes
  set status = 'POSTED', posted_at = now(), posted_by = current_account
  where id = p_stocktake_id
  returning * into result_row;
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'stocktakes',
      result_entity_id = p_stocktake_id, succeeded_at = now()
  where id = command_row.id;
  return result_row;
end;
$$;


revoke all on function public.post_stocktake(uuid, text, text) from public, anon;
grant execute on function public.post_stocktake(uuid, text, text) to authenticated;
