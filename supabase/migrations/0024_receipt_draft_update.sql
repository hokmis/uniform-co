-- DRAFT receipt classification remains editable; POSTED receipts remain immutable.
create or replace function public.update_purchase_receipt_draft(
  p_receipt_id uuid,
  p_delivered_quantity bigint,
  p_accepted_quantity bigint,
  p_rejected_quantity bigint,
  p_rejection_reason text,
  p_received_on date,
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
  receipt_line_row public.purchase_receipt_lines;
  po_line_row public.purchase_order_lines;
  related_po_line record;
  locked_item_id uuid;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('WAREHOUSE') then
    raise exception using errcode = '42501', message = 'WAREHOUSE role is required';
  end if;
  if p_receipt_id is null or p_delivered_quantity < 0 or p_accepted_quantity < 0 or p_rejected_quantity < 0
     or btrim(coalesce(p_idempotency_key, '')) = '' or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'Receipt draft fields are invalid';
  end if;
  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('UPDATE_PURCHASE_RECEIPT_DRAFT', p_idempotency_key, p_request_fingerprint, current_account)
  on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'UPDATE_PURCHASE_RECEIPT_DRAFT' and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' then select * into receipt_row from public.purchase_receipts where id = command_row.result_entity_id; return receipt_row; end if;
    raise exception using errcode = '40001', message = 'receipt draft update is already in progress or failed';
  end if;
  select * into receipt_row from public.purchase_receipts where id = p_receipt_id;
  if receipt_row.id is null then raise exception 'Receipt not found'; end if;
  select * into receipt_line_row from public.purchase_receipt_lines where receipt_id = p_receipt_id order by id limit 1;
  select * into po_line_row from public.purchase_order_lines where id = receipt_line_row.purchase_order_line_id;
  if po_line_row.id is null then raise exception 'Receipt has no valid purchase order line'; end if;
  locked_item_id := po_line_row.item_id;
  insert into public.inventory_item_locks (item_id) values (locked_item_id) on conflict (item_id) do nothing;
  perform 1 from public.inventory_item_locks where item_id = locked_item_id for update;
  select * into po_row from public.purchase_orders where id = receipt_row.purchase_order_id for update;
  if po_row.status not in ('ORDERED', 'PARTIALLY_RECEIVED', 'REOPENED') then raise exception 'Purchase order is not open for receipt'; end if;
  perform 1 from public.seasonal_procurement_lines sp
  where sp.id = po_line_row.seasonal_procurement_line_id for update;
  for related_po_line in select pol.id from public.purchase_order_lines pol where pol.purchase_order_id = po_row.id order by pol.id for update loop null; end loop;
  select * into receipt_row from public.purchase_receipts where id = p_receipt_id for update;
  if receipt_row.status <> 'DRAFT' then raise exception using errcode = '40001', message = 'Receipt changed while locking; retry'; end if;
  select * into receipt_line_row from public.purchase_receipt_lines where receipt_id = p_receipt_id order by id limit 1 for update;
  select * into po_line_row from public.purchase_order_lines where id = receipt_line_row.purchase_order_line_id for update;
  if po_line_row.id is null or po_line_row.item_id <> receipt_line_row.item_id then raise exception 'Receipt line source changed; retry'; end if;
  update public.purchase_receipts set received_on = p_received_on where id = p_receipt_id returning * into receipt_row;
  update public.purchase_receipt_lines set
    delivered_quantity = p_delivered_quantity,
    accepted_quantity = p_accepted_quantity,
    rejected_quantity = p_rejected_quantity,
    rejection_reason = nullif(btrim(p_rejection_reason), '')
  where id = receipt_line_row.id;
  update public.operation_commands set status = 'SUCCEEDED', result_entity_type = 'purchase_receipts', result_entity_id = p_receipt_id, succeeded_at = now() where id = command_row.id;
  return receipt_row;
end;
$$;

revoke all on function public.update_purchase_receipt_draft(uuid, bigint, bigint, bigint, text, date, text, text) from public, anon;
grant execute on function public.update_purchase_receipt_draft(uuid, bigint, bigint, bigint, text, date, text, text) to authenticated;
