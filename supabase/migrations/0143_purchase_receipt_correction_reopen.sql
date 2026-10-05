-- Count posted receipt corrections when validating additional receipts and
-- recalculating purchase-order completion after a receipt correction reopens it.
create or replace function public.post_purchase_receipt(
  p_receipt_id uuid,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.purchase_receipts
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  receipt_row public.purchase_receipts;
  po_row public.purchase_orders;
  po_line_row public.purchase_order_lines;
  receipt_line_row public.purchase_receipt_lines;
  general_warehouse_id uuid;
  balance_row public.inventory_balances;
  accepted_to_date bigint;
  delivered_to_date bigint;
  remaining_to_accept bigint;
  posting_id uuid;
  related_po_line record;
  locked_item_id uuid;
begin
  current_account := private.current_account_id();
  if auth.uid() is null
     or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null
     or not private.has_role('WAREHOUSE') then
    raise exception using errcode = '42501', message = 'WAREHOUSE role is required';
  end if;
  if btrim(coalesce(p_idempotency_key, '')) = ''
     or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'idempotency_key and request_fingerprint are required';
  end if;

  insert into public.operation_commands (
    operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id
  ) values (
    'POST_PURCHASE_RECEIPT', p_idempotency_key, p_request_fingerprint, current_account
  ) on conflict (operation_code, idempotency_key) do nothing
  returning * into command_row;
  if command_row.id is null then
    select * into command_row
    from public.operation_commands
    where operation_code = 'POST_PURCHASE_RECEIPT'
      and idempotency_key = p_idempotency_key
    for update;
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' then
      select * into receipt_row
      from public.purchase_receipts
      where id = command_row.result_entity_id;
      return receipt_row;
    end if;
    raise exception using errcode = '40001', message = 'receipt POST is already in progress or failed';
  end if;

  select * into receipt_row
  from public.purchase_receipts
  where id = p_receipt_id;
  if receipt_row.id is null or receipt_row.status <> 'DRAFT' then
    raise exception 'Only DRAFT receipts can be posted';
  end if;
  select * into receipt_line_row
  from public.purchase_receipt_lines
  where receipt_id = p_receipt_id
  order by id
  limit 1;
  select * into po_line_row
  from public.purchase_order_lines
  where id = receipt_line_row.purchase_order_line_id;
  if po_line_row.id is null then
    raise exception 'Receipt has no valid purchase order line';
  end if;
  locked_item_id := po_line_row.item_id;
  if receipt_line_row.delivered_quantity <= 0
     or receipt_line_row.accepted_quantity + receipt_line_row.rejected_quantity <> receipt_line_row.delivered_quantity then
    raise exception 'Receipt must have a complete quantity classification before POST';
  end if;
  if receipt_line_row.rejected_quantity > 0
     and btrim(coalesce(receipt_line_row.rejection_reason, '')) = '' then
    raise exception 'A rejection reason is required before POST';
  end if;

  insert into public.inventory_item_locks (item_id)
  values (po_line_row.item_id)
  on conflict (item_id) do nothing;
  perform 1 from public.inventory_item_locks
  where item_id = po_line_row.item_id
  for update;
  select * into po_row
  from public.purchase_orders
  where id = receipt_row.purchase_order_id
  for update;
  if po_row.status not in ('ORDERED', 'PARTIALLY_RECEIVED', 'REOPENED') then
    raise exception 'Purchase order is closed for receipt';
  end if;
  perform 1
  from public.seasonal_procurement_lines sp
  where sp.id = (
    select pol.seasonal_procurement_line_id
    from public.purchase_order_lines pol
    join public.purchase_receipt_lines rpl on rpl.purchase_order_line_id = pol.id
    where rpl.receipt_id = p_receipt_id
    limit 1
  )
  for update;
  for related_po_line in
    select pol.id
    from public.purchase_order_lines pol
    where pol.purchase_order_id = po_row.id
    order by pol.id
    for update
  loop
    null;
  end loop;
  select * into receipt_row
  from public.purchase_receipts
  where id = p_receipt_id
  for update;
  if receipt_row.status <> 'DRAFT' then
    raise exception using errcode = '40001', message = 'Receipt changed while locking; retry';
  end if;
  select * into receipt_line_row
  from public.purchase_receipt_lines
  where receipt_id = p_receipt_id
  order by id
  limit 1
  for update;
  select * into po_line_row
  from public.purchase_order_lines
  where id = receipt_line_row.purchase_order_line_id
  for update;
  if po_line_row.item_id <> locked_item_id then
    raise exception using errcode = '40001', message = 'Receipt item changed while locking; retry';
  end if;
  if receipt_line_row.delivered_quantity <= 0
     or receipt_line_row.accepted_quantity + receipt_line_row.rejected_quantity <> receipt_line_row.delivered_quantity then
    raise exception 'Receipt must have a complete quantity classification before POST';
  end if;
  if receipt_line_row.rejected_quantity > 0
     and btrim(coalesce(receipt_line_row.rejection_reason, '')) = '' then
    raise exception 'A rejection reason is required before POST';
  end if;

  -- Corrections are immutable rows, so the effective consumed amount is the
  -- posted receipt total plus posted correction deltas for its source lines.
  select coalesce(sum(receipt_line.accepted_quantity), 0)::bigint
       + coalesce((
           select sum(correction_line.accepted_quantity_delta)::bigint
           from public.purchase_receipt_correction_lines correction_line
           join public.correction_notes correction
             on correction.id = correction_line.correction_note_id
           join public.purchase_receipts source_receipt
             on source_receipt.id = correction_line.original_purchase_receipt_id
            and source_receipt.status = 'POSTED'
            and correction.original_purchase_receipt_id = source_receipt.id
           join public.purchase_receipt_lines source_line
             on source_line.id = correction_line.original_receipt_line_id
            and source_line.receipt_id = source_receipt.id
           where source_receipt.purchase_order_id = po_row.id
             and source_line.purchase_order_line_id = po_line_row.id
             and correction.correction_kind = 'PURCHASE_RECEIPT'
             and correction.status = 'POSTED'
         ), 0)::bigint
    into accepted_to_date
  from public.purchase_receipt_lines receipt_line
  join public.purchase_receipts receipt on receipt.id = receipt_line.receipt_id
  where receipt.purchase_order_id = po_row.id
    and receipt.status = 'POSTED'
    and receipt_line.purchase_order_line_id = po_line_row.id;

  select coalesce(sum(receipt_line.delivered_quantity), 0)::bigint
       + coalesce((
           select sum(correction_line.delivered_quantity_delta)::bigint
           from public.purchase_receipt_correction_lines correction_line
           join public.correction_notes correction
             on correction.id = correction_line.correction_note_id
           join public.purchase_receipts source_receipt
             on source_receipt.id = correction_line.original_purchase_receipt_id
            and source_receipt.status = 'POSTED'
            and correction.original_purchase_receipt_id = source_receipt.id
           join public.purchase_receipt_lines source_line
             on source_line.id = correction_line.original_receipt_line_id
            and source_line.receipt_id = source_receipt.id
           where source_receipt.purchase_order_id = po_row.id
             and source_line.purchase_order_line_id = po_line_row.id
             and correction.correction_kind = 'PURCHASE_RECEIPT'
             and correction.status = 'POSTED'
         ), 0)::bigint
    into delivered_to_date
  from public.purchase_receipt_lines receipt_line
  join public.purchase_receipts receipt on receipt.id = receipt_line.receipt_id
  where receipt.purchase_order_id = po_row.id
    and receipt.status = 'POSTED'
    and receipt_line.purchase_order_line_id = po_line_row.id;

  remaining_to_accept := po_line_row.ordered_quantity - accepted_to_date;
  if receipt_line_row.accepted_quantity > remaining_to_accept
     or receipt_line_row.delivered_quantity > po_line_row.ordered_quantity - delivered_to_date then
    raise exception 'Receipt quantity exceeds the ordered quantity';
  end if;

  select id into general_warehouse_id
  from public.warehouses
  where purpose = 'GENERAL' and is_active;
  if general_warehouse_id is null then
    raise exception 'An active GENERAL warehouse is required';
  end if;
  insert into public.inventory_balances (warehouse_id, item_id)
  values (general_warehouse_id, po_line_row.item_id)
  on conflict (warehouse_id, item_id) do nothing;
  select * into balance_row
  from public.inventory_balances
  where warehouse_id = general_warehouse_id
    and item_id = po_line_row.item_id
  for update;
  insert into public.inventory_postings (
    idempotency_key, posting_kind, source_entity_id, posted_by
  ) values (
    p_idempotency_key, 'RECEIPT', p_receipt_id, current_account
  ) returning id into posting_id;
  insert into public.purchase_receipt_posting_sources (posting_id, receipt_id)
  values (posting_id, p_receipt_id);
  if receipt_line_row.accepted_quantity > 0 then
    insert into public.inventory_ledger_entries (
      posting_id, line_no, warehouse_id, item_id, movement_kind, quantity_delta, occurred_on
    ) values (
      posting_id, 1, general_warehouse_id, po_line_row.item_id,
      'RECEIPT_IN', receipt_line_row.accepted_quantity, receipt_row.received_on
    );
    update public.inventory_balances
    set on_hand_quantity = on_hand_quantity + receipt_line_row.accepted_quantity,
        version = version + 1,
        last_posting_id = posting_id,
        updated_at = now()
    where warehouse_id = general_warehouse_id
      and item_id = po_line_row.item_id;
  end if;
  update public.purchase_receipts
  set status = 'POSTED', posted_at = now(), posted_by = current_account
  where id = p_receipt_id
  returning * into receipt_row;

  -- Recompute the whole order from effective accepted quantities. A receipt
  -- correction can reopen a previously received order, and an order may have
  -- more than one line.
  if exists (
    select 1
    from public.purchase_order_lines purchase_order_line
    where purchase_order_line.purchase_order_id = po_row.id
      and purchase_order_line.ordered_quantity > (
        coalesce((
          select sum(receipt_line.accepted_quantity)::bigint
          from public.purchase_receipt_lines receipt_line
          join public.purchase_receipts receipt on receipt.id = receipt_line.receipt_id
          where receipt.purchase_order_id = po_row.id
            and receipt.status = 'POSTED'
            and receipt_line.purchase_order_line_id = purchase_order_line.id
        ), 0)::bigint
        + coalesce((
          select sum(correction_line.accepted_quantity_delta)::bigint
          from public.purchase_receipt_correction_lines correction_line
          join public.correction_notes correction
            on correction.id = correction_line.correction_note_id
          join public.purchase_receipts source_receipt
            on source_receipt.id = correction_line.original_purchase_receipt_id
           and source_receipt.status = 'POSTED'
           and correction.original_purchase_receipt_id = source_receipt.id
          join public.purchase_receipt_lines source_line
            on source_line.id = correction_line.original_receipt_line_id
           and source_line.receipt_id = source_receipt.id
          where source_receipt.purchase_order_id = po_row.id
            and source_line.purchase_order_line_id = purchase_order_line.id
            and correction.correction_kind = 'PURCHASE_RECEIPT'
            and correction.status = 'POSTED'
        ), 0)::bigint
      )
  ) then
    update public.purchase_orders
    set status = 'PARTIALLY_RECEIVED'
    where id = po_row.id;
  else
    update public.purchase_orders
    set status = 'RECEIVED'
    where id = po_row.id;
  end if;

  update public.operation_commands
  set status = 'SUCCEEDED',
      result_entity_type = 'purchase_receipts',
      result_entity_id = p_receipt_id,
      succeeded_at = now()
  where id = command_row.id;
  return receipt_row;
end;
$$;

revoke all on function public.post_purchase_receipt(uuid, text, text)
  from public, anon;
grant execute on function public.post_purchase_receipt(uuid, text, text)
  to authenticated;
