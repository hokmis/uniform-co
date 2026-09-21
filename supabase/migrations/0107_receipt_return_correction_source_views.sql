-- Consolidate posted receipt and return correction catalogs.
-- security_invoker keeps the existing source-table RLS policies authoritative.

create or replace view public.v_purchase_receipt_correction_sources
with (security_invoker = true)
as
select
  receipt_line.id as line_id,
  receipt_row.id as receipt_id,
  receipt_row.receipt_no,
  receipt_row.purchase_order_id,
  receipt_row.received_on,
  receipt_line.item_code_snapshot as item_code,
  receipt_line.item_name_snapshot as item_name,
  receipt_line.delivered_quantity,
  receipt_line.accepted_quantity,
  receipt_line.rejected_quantity
from public.purchase_receipts receipt_row
join public.purchase_receipt_lines receipt_line
  on receipt_line.receipt_id = receipt_row.id
where receipt_row.status = 'POSTED';

create or replace view public.v_return_correction_sources
with (security_invoker = true)
as
select
  return_line.id as line_id,
  return_row.id as return_id,
  return_row.return_no,
  return_row.original_hr_request_id,
  return_row.status,
  return_line.original_issue_line_id,
  return_line.employee_no_snapshot,
  return_line.employee_name_snapshot,
  return_line.item_code_snapshot as item_code,
  return_line.item_name_snapshot as item_name,
  return_line.quantity,
  return_line.unit_snapshot
from public.return_notes return_row
join public.return_lines return_line
  on return_line.return_note_id = return_row.id
where return_row.status = 'POSTED';

revoke all on table public.v_purchase_receipt_correction_sources,
  public.v_return_correction_sources
from public, anon, authenticated;
grant select on public.v_purchase_receipt_correction_sources,
  public.v_return_correction_sources to authenticated;
