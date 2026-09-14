-- Corrections against different item lines of the same shipped request must
-- share one fence before taking item mutexes; this prevents cross-item cycles.
create or replace function public.post_return_correction(
  p_correction_note_id uuid,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.correction_notes
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  correction_row public.correction_notes;
  correction_line public.return_correction_lines;
  source_return_line public.return_lines;
  return_row public.return_notes;
  issue_line public.hr_issue_lines;
  issue_request public.hr_requests;
  item_id_row record;
  request_id_row record;
  related_item record;
  candidate_request_ids uuid[];
  candidate_item_ids uuid[];
  locked_request_ids uuid[];
  locked_item_ids uuid[];
  affected_request_ids uuid[];
  hr_warehouse_id uuid;
  general_warehouse_id uuid;
  balance_row public.inventory_balances;
  pre_returned bigint;
  effective_issued bigint;
  new_returned bigint;
  return_delta bigint;
  combined_on_hand bigint;
  active_reserved bigint;
  posting_id uuid;
  request_row record;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('HR') then
    raise exception using errcode = '42501', message = 'HR role is required';
  end if;
  if btrim(coalesce(p_idempotency_key, '')) = ''
     or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'idempotency_key and request_fingerprint are required';
  end if;
  insert into public.operation_commands (
    operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id
  ) values (
    'POST_RETURN_CORRECTION', p_idempotency_key, p_request_fingerprint, current_account
  ) on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'POST_RETURN_CORRECTION'
      and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' then
      select * into correction_row from public.correction_notes
      where id = command_row.result_entity_id;
      return correction_row;
    end if;
    raise exception using errcode = '40001', message = 'Return correction POST is already in progress or failed';
  end if;

  select * into correction_row from public.correction_notes where id = p_correction_note_id;
  select * into correction_line from public.return_correction_lines
  where correction_note_id = p_correction_note_id order by id limit 1;
  if correction_row.id is null or correction_row.status <> 'DRAFT'
     or correction_row.correction_kind <> 'RETURN' or correction_line.id is null then
    raise exception 'Only a DRAFT RETURN correction can be posted';
  end if;
  select * into source_return_line from public.return_lines
  where return_note_id = correction_line.original_return_note_id
    and id = correction_line.original_return_line_id;
  select * into return_row from public.return_notes
  where id = correction_line.original_return_note_id;
  select * into issue_line from public.hr_issue_lines
  where request_id = correction_line.original_hr_request_id
    and id = correction_line.original_issue_line_id;
  if source_return_line.id is null or return_row.id is null or issue_line.id is null
     or source_return_line.item_id <> correction_line.item_id
     or source_return_line.original_issue_line_id <> issue_line.id then
    raise exception 'Return correction source identity mismatch';
  end if;

  -- Serialize corrections and returns on every line of one HR request.
  perform pg_advisory_xact_lock(hashtext(source_return_line.original_hr_request_id::text));

  -- Discover every item mutex needed if this correction uncovers a request.
  select coalesce(array_agg(q.source_hr_request_id order by q.source_hr_request_id), '{}'::uuid[])
    into candidate_request_ids
  from (select distinct r.source_hr_request_id
        from public.inventory_reservations r
        where r.item_id = source_return_line.item_id and r.status = 'ACTIVE') q;
  select coalesce(array_agg(q.item_id order by q.item_id), '{}'::uuid[])
    into candidate_item_ids
  from (
    select distinct r.item_id from public.inventory_reservations r
    where r.source_hr_request_id = any(candidate_request_ids) and r.status = 'ACTIVE'
    union select source_return_line.item_id
  ) q;
  for request_id_row in
    select request_id from unnest(candidate_request_ids) as requested(request_id) order by request_id
  loop
    perform pg_advisory_xact_lock(hashtext(request_id_row.request_id::text));
  end loop;
  for item_id_row in
    select item_id from unnest(candidate_item_ids) as requested(item_id) order by item_id
  loop
    insert into public.inventory_item_locks (item_id) values (item_id_row.item_id)
    on conflict (item_id) do nothing;
    perform 1 from public.inventory_item_locks where item_id = item_id_row.item_id for update;
  end loop;
  select coalesce(array_agg(q.source_hr_request_id order by q.source_hr_request_id), '{}'::uuid[])
    into locked_request_ids
  from (select distinct r.source_hr_request_id
        from public.inventory_reservations r
        where r.item_id = source_return_line.item_id and r.status = 'ACTIVE') q;
  select coalesce(array_agg(q.item_id order by q.item_id), '{}'::uuid[])
    into locked_item_ids
  from (
    select distinct r.item_id from public.inventory_reservations r
    where r.source_hr_request_id = any(locked_request_ids) and r.status = 'ACTIVE'
    union select source_return_line.item_id
  ) q;
  if locked_request_ids is distinct from candidate_request_ids
     or locked_item_ids is distinct from candidate_item_ids then
    raise exception using errcode = '40001', message = 'Reservation lock set changed while locking; retry';
  end if;

  -- Shared source locks: return parent first, then original issue line.
  select * into correction_row from public.correction_notes where id = p_correction_note_id for update;
  select * into correction_line from public.return_correction_lines
  where correction_note_id = p_correction_note_id order by id limit 1 for update;
  select * into return_row from public.return_notes
  where id = correction_line.original_return_note_id for update;
  select * into source_return_line from public.return_lines
  where return_note_id = correction_line.original_return_note_id
    and id = correction_line.original_return_line_id for update;
  select * into issue_line from public.hr_issue_lines
  where request_id = correction_line.original_hr_request_id
    and id = correction_line.original_issue_line_id for update;
  select * into issue_request from public.hr_requests where id = issue_line.request_id for update;
  if correction_row.status <> 'DRAFT' or return_row.status <> 'POSTED'
     or issue_request.status <> 'SHIPPED' or correction_row.original_return_note_id <> return_row.id
     or return_row.original_hr_request_id <> issue_line.request_id
     or source_return_line.item_id <> issue_line.item_id then
    raise exception using errcode = '40001', message = 'Return source changed while locking; retry';
  end if;

  select coalesce(sum(rl.quantity), 0)
    + coalesce((select sum(rc.return_quantity_delta)
                from public.return_correction_lines rc
                join public.correction_notes cn on cn.id = rc.correction_note_id
                where rc.original_hr_request_id = issue_line.request_id
                  and rc.original_issue_line_id = issue_line.id
                  and cn.status = 'POSTED' and cn.id <> correction_row.id), 0)
    into pre_returned
  from public.return_lines rl
  join public.return_notes rn on rn.id = rl.return_note_id
  where rl.original_hr_request_id = issue_line.request_id
    and rl.original_issue_line_id = issue_line.id and rn.status = 'POSTED';
  effective_issued := issue_line.quantity;
  return_delta := correction_line.return_quantity_delta;
  new_returned := pre_returned + return_delta;
  if new_returned < 0 or new_returned > effective_issued then
    raise exception 'Effective returned quantity must remain between zero and effective issued quantity';
  end if;

  select id into hr_warehouse_id from public.warehouses
  where purpose = 'HR' and is_active order by id limit 1;
  select id into general_warehouse_id from public.warehouses
  where purpose = 'GENERAL' and is_active order by id limit 1;
  if hr_warehouse_id is null or general_warehouse_id is null then
    raise exception 'Active HR and GENERAL warehouses are required';
  end if;
  insert into public.inventory_balances (warehouse_id, item_id)
  values (hr_warehouse_id, issue_line.item_id), (general_warehouse_id, issue_line.item_id)
  on conflict (warehouse_id, item_id) do nothing;
  perform 1 from public.inventory_balances b
  where b.item_id = issue_line.item_id
    and b.warehouse_id in (hr_warehouse_id, general_warehouse_id)
  order by b.warehouse_id for update;
  select * into balance_row from public.inventory_balances
  where warehouse_id = hr_warehouse_id and item_id = issue_line.item_id;
  if return_delta < 0 and balance_row.on_hand_quantity < -return_delta then
    raise exception 'Return correction would make HR stock negative';
  end if;
  perform 1 from public.inventory_reservations r
  where r.item_id = issue_line.item_id and r.status = 'ACTIVE'
  order by r.item_id, r.source_hr_request_id, r.id for update;
  select coalesce(sum(b.on_hand_quantity), 0) + return_delta into combined_on_hand
  from public.inventory_balances b
  where b.item_id = issue_line.item_id
    and b.warehouse_id in (hr_warehouse_id, general_warehouse_id);
  select coalesce(sum(r.quantity), 0) into active_reserved
  from public.inventory_reservations r
  where r.item_id = issue_line.item_id and r.status = 'ACTIVE';
  if combined_on_hand < active_reserved then
    select coalesce(array_agg(x.source_hr_request_id order by x.source_hr_request_id), '{}'::uuid[])
      into affected_request_ids
    from (select distinct source_hr_request_id from public.inventory_reservations
          where item_id = issue_line.item_id and status = 'ACTIVE') x;
    for request_row in
      select id from public.hr_requests where id = any(affected_request_ids) order by id
    loop
      perform 1 from public.hr_requests where id = request_row.id for update;
    end loop;
    for request_row in
      select distinct source_hr_request_id as id from public.inventory_reservations
      where source_hr_request_id = any(affected_request_ids) order by source_hr_request_id
    loop
      perform 1 from public.inventory_reservations r
      where r.source_hr_request_id = request_row.id order by r.item_id, r.id for update;
    end loop;
    update public.inventory_reservations
    set status = 'CONFLICTED', closed_at = coalesce(closed_at, now())
    where source_hr_request_id = any(affected_request_ids) and status = 'ACTIVE';
    update public.hr_requests
    set status = 'INVENTORY_REVIEW_REQUIRED', row_version = row_version + 1
    where id = any(affected_request_ids) and status = 'SUBMITTED';
  end if;

  insert into public.inventory_postings (idempotency_key, posting_kind, source_entity_id, posted_by)
  values (p_idempotency_key, 'CORRECTION', p_correction_note_id, current_account)
  returning id into posting_id;
  insert into public.correction_posting_sources (posting_id, correction_note_id)
  values (posting_id, p_correction_note_id);
  insert into public.inventory_ledger_entries (
    posting_id, line_no, warehouse_id, item_id, movement_kind, quantity_delta, occurred_on
  ) values (
    posting_id, 1, hr_warehouse_id, issue_line.item_id,
    'RETURN_CORRECTION', return_delta, current_date
  );
  update public.inventory_balances
  set on_hand_quantity = on_hand_quantity + return_delta,
      version = version + 1, last_posting_id = posting_id, updated_at = now()
  where warehouse_id = hr_warehouse_id and item_id = issue_line.item_id;
  update public.correction_notes
  set status = 'POSTED', posted_at = now(), posted_by = current_account
  where id = p_correction_note_id returning * into correction_row;
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'correction_notes',
      result_entity_id = p_correction_note_id, succeeded_at = now()
  where id = command_row.id;
  return correction_row;
end;
$$;


