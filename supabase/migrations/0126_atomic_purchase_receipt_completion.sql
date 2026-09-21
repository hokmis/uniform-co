-- Complete the common one-step receipt path in one database transaction and
-- one browser round trip, reusing the existing guarded/idempotent operations.
create or replace function public.complete_purchase_receipt(
  p_receipt_no text,
  p_purchase_order_line_id uuid,
  p_delivered_quantity bigint,
  p_accepted_quantity bigint,
  p_rejected_quantity bigint,
  p_rejection_reason text,
  p_received_on date,
  p_create_idempotency_key text,
  p_create_request_fingerprint text,
  p_post_idempotency_key text,
  p_post_request_fingerprint text
)
returns public.purchase_receipts
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  locked_item_id uuid;
  draft_receipt public.purchase_receipts;
  completed_receipt public.purchase_receipts;
begin
  current_account := private.current_account_id();
  if auth.uid() is null
     or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null
     or not private.has_role('WAREHOUSE') then
    raise exception using errcode = '42501', message = 'WAREHOUSE role is required';
  end if;

  -- Match the POST RPC's item-before-purchase-order lock order. The explicit
  -- role check above protects the SECURITY DEFINER lock-table access.
  select pol.item_id into locked_item_id
  from public.purchase_order_lines pol
  where pol.id = p_purchase_order_line_id;
  if locked_item_id is null then
    raise exception 'Purchase order line does not exist';
  end if;
  insert into public.inventory_item_locks (item_id)
  values (locked_item_id)
  on conflict (item_id) do nothing;
  perform 1 from public.inventory_item_locks
  where item_id = locked_item_id
  for update;

  draft_receipt := public.create_purchase_receipt_draft(
    p_receipt_no,
    p_purchase_order_line_id,
    p_delivered_quantity,
    p_accepted_quantity,
    p_rejected_quantity,
    p_rejection_reason,
    p_received_on,
    p_create_idempotency_key,
    p_create_request_fingerprint
  );

  completed_receipt := public.post_purchase_receipt(
    draft_receipt.id,
    p_post_idempotency_key,
    p_post_request_fingerprint
  );

  return completed_receipt;
end;
$$;

revoke all on function public.complete_purchase_receipt(text, uuid, bigint, bigint, bigint, text, date, text, text, text, text)
  from public, anon;
grant execute on function public.complete_purchase_receipt(text, uuid, bigint, bigint, bigint, text, date, text, text, text, text)
  to authenticated;
