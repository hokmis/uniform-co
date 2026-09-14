-- Forward reconciliation for receipt corrections.
--
-- This replaces the 0009 POST implementation rather than adding an AFTER
-- trigger: inventory, reservation, PO allocation, and audit state must be
-- decided while the shared source locks are still held.  In particular, the
-- inventory movement for a correction is the delta on this correction only;
-- historical correction deltas are used solely to validate the effective
-- receipt quantities.

create or replace function public.post_purchase_receipt_correction(
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
  correction_line public.purchase_receipt_correction_lines;
  source_line public.purchase_receipt_lines;
  receipt_row public.purchase_receipts;
  po_row public.purchase_orders;
  po_line_row public.purchase_order_lines;
  procurement_id uuid;
  general_warehouse_id uuid;
  hr_warehouse_id uuid;
  general_balance public.inventory_balances;
  pre_delivered bigint;
  pre_accepted bigint;
  pre_rejected bigint;
  new_delivered bigint;
  new_accepted bigint;
  new_rejected bigint;
  accepted_delta bigint;
  current_limit bigint;
  allocated_quantity bigint;
  combined_on_hand bigint;
  active_reserved bigint;
  posting_id uuid;
  related_po record;
  related_line record;
  request_row record;
  target_status public.purchase_orders.status%type;
  candidate_request_ids uuid[];
  candidate_item_ids uuid[];
  item_id_row record;
  request_id_row record;
  locked_request_ids uuid[];
  locked_item_ids uuid[];
  affected_request_ids uuid[];
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('WAREHOUSE') then
    raise exception using errcode = '42501', message = 'WAREHOUSE role is required';
  end if;
  if btrim(coalesce(p_idempotency_key, '')) = ''
     or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'idempotency_key and request_fingerprint are required';
  end if;

  insert into public.operation_commands (
    operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id
  ) values (
    'POST_PURCHASE_RECEIPT_CORRECTION', p_idempotency_key,
    p_request_fingerprint, current_account
  ) on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'POST_PURCHASE_RECEIPT_CORRECTION'
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
    raise exception using errcode = '40001', message = 'Correction POST is already in progress or failed';
  end if;

  select * into correction_row from public.correction_notes
  where id = p_correction_note_id;
  if correction_row.id is null or correction_row.status <> 'DRAFT' then
    raise exception 'Only DRAFT corrections can be posted';
  end if;
  select * into correction_line
  from public.purchase_receipt_correction_lines
  where correction_note_id = correction_row.id order by id limit 1;
  if correction_line.id is null then raise exception 'Correction line is required'; end if;
  select * into source_line from public.purchase_receipt_lines
  where receipt_id = correction_line.original_purchase_receipt_id
    and id = correction_line.original_receipt_line_id;
  select * into receipt_row from public.purchase_receipts
  where id = source_line.receipt_id;
  if source_line.id is null or receipt_row.id is null or receipt_row.status <> 'POSTED'
     or correction_row.original_purchase_receipt_id <> receipt_row.id then
    raise exception 'Only a POSTED source receipt can be corrected';
  end if;
  select * into po_line_row from public.purchase_order_lines
  where id = source_line.purchase_order_line_id;
  if po_line_row.id is null or po_line_row.purchase_order_id <> receipt_row.purchase_order_id
     or po_line_row.item_id <> source_line.item_id then
    raise exception 'Source purchase order line changed';
  end if;
  procurement_id := po_line_row.seasonal_procurement_line_id;

  -- All receipt/correction/PO quantity operations serialize on the item and
  -- on the complete procurement decision PO group.
  -- Discover the request/item lock set before taking any item mutex.  This
  -- prevents two corrections for different items of the same HR request
  -- from taking item locks in opposite order during conflict reconciliation.
  select coalesce(array_agg(q.source_hr_request_id order by q.source_hr_request_id), '{}'::uuid[])
    into candidate_request_ids
  from (select distinct r.source_hr_request_id
        from public.inventory_reservations r
        where r.item_id = source_line.item_id and r.status = 'ACTIVE') q;
  select coalesce(array_agg(q.item_id order by q.item_id), '{}'::uuid[])
    into candidate_item_ids
  from (
    select distinct r.item_id
    from public.inventory_reservations r
    where r.source_hr_request_id = any(candidate_request_ids) and r.status = 'ACTIVE'
    union
    select source_line.item_id
  ) q;
  -- Corrections for multiple items of one HR request must serialize before
  -- taking item mutexes.  The sorted advisory locks close the case where a
  -- request already has reservations for two items and both corrections
  -- discover the other reservation at the same time.
  for request_id_row in
    select request_id from unnest(candidate_request_ids) as requested(request_id)
    order by request_id
  loop
    perform pg_advisory_xact_lock(hashtext(request_id_row.request_id::text));
  end loop;
  for item_id_row in
    select item_id from unnest(candidate_item_ids) as requested(item_id) order by item_id
  loop
    insert into public.inventory_item_locks (item_id)
    values (item_id_row.item_id) on conflict (item_id) do nothing;
    perform 1 from public.inventory_item_locks
    where item_id = item_id_row.item_id for update;
  end loop;
  -- A submit/return transaction may have committed a new reservation between
  -- the discovery query and the mutex acquisition.  Do not continue with a
  -- partial lock set: force the caller to retry from a fresh, stable set.
  select coalesce(array_agg(q.source_hr_request_id order by q.source_hr_request_id), '{}'::uuid[])
    into locked_request_ids
  from (select distinct r.source_hr_request_id
        from public.inventory_reservations r
        where r.item_id = source_line.item_id and r.status = 'ACTIVE') q;
  select coalesce(array_agg(q.item_id order by q.item_id), '{}'::uuid[])
    into locked_item_ids
  from (
    select distinct r.item_id
    from public.inventory_reservations r
    where r.source_hr_request_id = any(locked_request_ids) and r.status = 'ACTIVE'
    union
    select source_line.item_id
  ) q;
  if locked_request_ids is distinct from candidate_request_ids
     or locked_item_ids is distinct from candidate_item_ids then
    raise exception using errcode = '40001',
      message = 'Reservation lock set changed while locking; retry';
  end if;
  for related_po in
    select po.id
    from public.purchase_orders po
    join public.purchase_order_lines pol on pol.purchase_order_id = po.id
    where pol.seasonal_procurement_line_id = procurement_id
    group by po.id order by po.id
  loop
    perform 1 from public.purchase_orders where id = related_po.id for update;
  end loop;
  perform 1 from public.seasonal_procurement_lines
  where id = procurement_id for update;
  for related_line in
    select pol.id from public.purchase_order_lines pol
    where pol.seasonal_procurement_line_id = procurement_id
    order by pol.id
  loop
    perform 1 from public.purchase_order_lines where id = related_line.id for update;
  end loop;

  -- Re-read every source row after the shared locks.
  select * into correction_row from public.correction_notes
  where id = p_correction_note_id for update;
  select * into correction_line
  from public.purchase_receipt_correction_lines
  where correction_note_id = correction_row.id order by id limit 1 for update;
  select * into source_line from public.purchase_receipt_lines
  where receipt_id = correction_line.original_purchase_receipt_id
    and id = correction_line.original_receipt_line_id for update;
  select * into receipt_row from public.purchase_receipts
  where id = source_line.receipt_id for update;
  select * into po_row from public.purchase_orders
  where id = receipt_row.purchase_order_id for update;
  select * into po_line_row from public.purchase_order_lines
  where id = source_line.purchase_order_line_id for update;
  if correction_row.status <> 'DRAFT' or receipt_row.status <> 'POSTED'
     or po_row.status = 'CANCELLED' or po_line_row.item_id <> source_line.item_id
     or po_line_row.purchase_order_id <> receipt_row.purchase_order_id then
    raise exception using errcode = '40001', message = 'Correction source changed while locking; retry';
  end if;

  -- Effective quantities before this correction.  The current correction is
  -- deliberately excluded so its delta is never applied twice.
  select source_line.delivered_quantity + coalesce(sum(cl.delivered_quantity_delta), 0),
         source_line.accepted_quantity + coalesce(sum(cl.accepted_quantity_delta), 0),
         source_line.rejected_quantity + coalesce(sum(cl.rejected_quantity_delta), 0)
    into pre_delivered, pre_accepted, pre_rejected
  from public.purchase_receipt_correction_lines cl
  join public.correction_notes cn on cn.id = cl.correction_note_id
  where cl.original_purchase_receipt_id = source_line.receipt_id
    and cl.original_receipt_line_id = source_line.id
    and cn.status = 'POSTED' and cn.id <> correction_row.id;
  new_delivered := pre_delivered + correction_line.delivered_quantity_delta;
  new_accepted := pre_accepted + correction_line.accepted_quantity_delta;
  new_rejected := pre_rejected + correction_line.rejected_quantity_delta;
  if new_delivered < 0 or new_accepted < 0 or new_rejected < 0
     or new_accepted + new_rejected <> new_delivered then
    raise exception 'Correction would leave invalid effective receipt classification';
  end if;
  if new_accepted > po_line_row.ordered_quantity then
    raise exception 'Effective accepted quantity exceeds ordered quantity';
  end if;
  accepted_delta := correction_line.accepted_quantity_delta;

  select id into general_warehouse_id from public.warehouses
  where purpose = 'GENERAL' and is_active order by id limit 1;
  select id into hr_warehouse_id from public.warehouses
  where purpose = 'HR' and is_active order by id limit 1;
  if general_warehouse_id is null or hr_warehouse_id is null then
    raise exception 'Active HR and GENERAL warehouses are required';
  end if;
  insert into public.inventory_balances (warehouse_id, item_id)
  values (general_warehouse_id, source_line.item_id),
         (hr_warehouse_id, source_line.item_id)
  on conflict (warehouse_id, item_id) do nothing;
  -- Lock both balances in warehouse order before reservation coverage checks.
  perform 1 from public.inventory_balances b
  where b.item_id = source_line.item_id
    and b.warehouse_id in (hr_warehouse_id, general_warehouse_id)
  order by b.warehouse_id for update;
  select * into general_balance from public.inventory_balances
  where warehouse_id = general_warehouse_id and item_id = source_line.item_id;
  if accepted_delta < 0 and general_balance.on_hand_quantity < -accepted_delta then
    raise exception 'Correction would make GENERAL stock negative';
  end if;

  -- Lock current-item reservations before computing coverage.  If coverage
  -- is lost, lock every reservation/request in deterministic order and mark
  -- the whole affected request conflicted in this same transaction.
  perform 1 from public.inventory_reservations r
  where r.item_id = source_line.item_id and r.status = 'ACTIVE'
  order by r.item_id, r.source_hr_request_id, r.id for update;
  select coalesce(sum(b.on_hand_quantity), 0) + accepted_delta
    into combined_on_hand
  from public.inventory_balances b
  where b.item_id = source_line.item_id
    and b.warehouse_id in (hr_warehouse_id, general_warehouse_id);
  select coalesce(sum(r.quantity), 0) into active_reserved
  from public.inventory_reservations r
  where r.item_id = source_line.item_id and r.status = 'ACTIVE';
  if combined_on_hand < active_reserved then
    select coalesce(array_agg(x.source_hr_request_id order by x.source_hr_request_id), '{}'::uuid[])
      into affected_request_ids
    from (select distinct source_hr_request_id
          from public.inventory_reservations
          where item_id = source_line.item_id and status = 'ACTIVE') x;
    for request_row in
      select id from public.hr_requests
      where id = any(affected_request_ids) order by id
    loop
      perform 1 from public.hr_requests where id = request_row.id for update;
    end loop;
    for request_row in
      select distinct source_hr_request_id as id
      from public.inventory_reservations
      where source_hr_request_id = any(affected_request_ids)
      order by source_hr_request_id
    loop
      perform 1 from public.inventory_reservations r
      where r.source_hr_request_id = request_row.id
      order by r.item_id, r.id for update;
    end loop;
    update public.inventory_reservations
    set status = 'CONFLICTED', closed_at = coalesce(closed_at, now())
    where source_hr_request_id = any(affected_request_ids) and status = 'ACTIVE';
    update public.hr_requests
    set status = 'INVENTORY_REVIEW_REQUIRED', row_version = row_version + 1
    where id = any(affected_request_ids) and status = 'SUBMITTED';
  end if;

  -- Revalidate allocation while the complete procurement group is locked.
  current_limit := coalesce((
    select c.new_purchase_limit_quantity
    from public.seasonal_procurement_line_changes c
    where c.procurement_line_id = procurement_id
    order by c.revision desc limit 1
  ), (select final_purchase_quantity from public.seasonal_procurement_lines where id = procurement_id));
  select coalesce(sum(case
    when po.status = 'CANCELLED' then 0
    when po.status = 'CLOSED_SHORT' then
      coalesce((select sum(prl.accepted_quantity)
                from public.purchase_receipt_lines prl
                join public.purchase_receipts pr on pr.id = prl.receipt_id
                where pr.purchase_order_id = po.id and pr.status = 'POSTED'
                  and prl.purchase_order_line_id = pol.id), 0)
      + coalesce((select sum(cl.accepted_quantity_delta)
                  from public.purchase_receipt_correction_lines cl
                  join public.correction_notes cn on cn.id = cl.correction_note_id
                  where cl.original_receipt_line_id in (
                    select prl.id from public.purchase_receipt_lines prl
                    where prl.purchase_order_line_id = pol.id)
                    and cn.status = 'POSTED'), 0)
      + case when pol.id = po_line_row.id then correction_line.accepted_quantity_delta else 0 end
    else pol.ordered_quantity end), 0)
    into allocated_quantity
  from public.purchase_order_lines pol
  join public.purchase_orders po on po.id = pol.purchase_order_id
  where pol.seasonal_procurement_line_id = procurement_id;
  if allocated_quantity > current_limit then
    raise exception 'Receipt correction would exceed current purchase limit';
  end if;

  insert into public.inventory_postings (
    idempotency_key, posting_kind, source_entity_id, posted_by
  ) values (p_idempotency_key, 'CORRECTION', p_correction_note_id, current_account)
  returning id into posting_id;
  insert into public.correction_posting_sources (posting_id, correction_note_id)
  values (posting_id, p_correction_note_id);
  if accepted_delta <> 0 then
    insert into public.inventory_ledger_entries (
      posting_id, line_no, warehouse_id, item_id, movement_kind, quantity_delta, occurred_on
    ) values (
      posting_id, 1, general_warehouse_id, source_line.item_id,
      'RECEIPT_CORRECTION', accepted_delta, current_date
    );
    update public.inventory_balances
    set on_hand_quantity = on_hand_quantity + accepted_delta,
        version = version + 1, last_posting_id = posting_id, updated_at = now()
    where warehouse_id = general_warehouse_id and item_id = source_line.item_id;
  end if;

  update public.correction_notes
  set status = 'POSTED', posted_at = now(), posted_by = current_account
  where id = p_correction_note_id returning * into correction_row;

  target_status := po_row.status;
  if po_row.status <> 'CLOSED_SHORT' then
    if exists (
      select 1 from public.purchase_order_lines pol
      where pol.purchase_order_id = po_row.id
        and pol.ordered_quantity > (
          coalesce((select sum(prl.accepted_quantity)
            from public.purchase_receipt_lines prl
            join public.purchase_receipts pr on pr.id = prl.receipt_id
            where pr.purchase_order_id = po_row.id and pr.status = 'POSTED'
              and prl.purchase_order_line_id = pol.id), 0)
          + coalesce((select sum(cl.accepted_quantity_delta)
            from public.purchase_receipt_correction_lines cl
            join public.correction_notes cn on cn.id = cl.correction_note_id
            where cl.original_receipt_line_id in (
              select prl.id from public.purchase_receipt_lines prl
              where prl.purchase_order_line_id = pol.id)
              and cn.status = 'POSTED'), 0)
        )
    ) then
      target_status := case when po_row.status = 'RECEIVED' then 'REOPENED' else 'PARTIALLY_RECEIVED' end;
    else
      target_status := 'RECEIVED';
    end if;
    if po_row.status = 'RECEIVED' and target_status = 'REOPENED' then
      update public.purchase_orders
      set status = target_status, reopened_at = now(), reopened_by = current_account,
          reopen_reason_kind = 'RECEIPT_CORRECTION'
      where id = po_row.id;
    else
      update public.purchase_orders set status = target_status where id = po_row.id;
    end if;
  end if;

  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'correction_notes',
      result_entity_id = p_correction_note_id, succeeded_at = now()
  where id = command_row.id;
  return correction_row;
end;
$$;

create or replace function public.get_purchase_receipt_correction_status(
  p_correction_note_id uuid default null,
  p_create_idempotency_key text default null,
  p_post_idempotency_key text default null
)
returns public.correction_notes
language plpgsql security definer set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  correction_id uuid := p_correction_note_id;
  correction_row public.correction_notes;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('WAREHOUSE') then
    raise exception using errcode = '42501', message = 'WAREHOUSE role is required';
  end if;
  if correction_id is null and btrim(coalesce(p_create_idempotency_key, '')) <> '' then
    select result_entity_id into correction_id from public.operation_commands
    where operation_code = 'CREATE_PURCHASE_RECEIPT_CORRECTION'
      and idempotency_key = p_create_idempotency_key and actor_account_id = current_account;
  end if;
  if correction_id is null and btrim(coalesce(p_post_idempotency_key, '')) <> '' then
    select result_entity_id into correction_id from public.operation_commands
    where operation_code = 'POST_PURCHASE_RECEIPT_CORRECTION'
      and idempotency_key = p_post_idempotency_key and actor_account_id = current_account;
  end if;
  if correction_id is null then return null; end if;
  select * into correction_row from public.correction_notes
  where id = correction_id and (created_by = current_account or private.has_role('HR'));
  return correction_row;
end;
$$;

revoke all on function public.post_purchase_receipt_correction(uuid, text, text) from public, anon;
grant execute on function public.post_purchase_receipt_correction(uuid, text, text) to authenticated;
revoke all on function public.get_purchase_receipt_correction_status(uuid, text, text) from public, anon;
grant execute on function public.get_purchase_receipt_correction_status(uuid, text, text) to authenticated;
