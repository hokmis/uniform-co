-- Consolidate correction history reads for the correction workbenches.
-- The view is security-invoker so source-table RLS remains authoritative.

create or replace view public.v_correction_history
with (security_invoker = true)
as
select
  note.id as correction_id,
  note.correction_kind,
  'PURCHASE_RECEIPT'::text as source_kind,
  note.correction_no,
  note.status,
  note.reason,
  note.posted_at,
  note.original_purchase_receipt_id as source_parent_id,
  line.original_receipt_line_id as source_line_id,
  null::bigint as delta_quantity,
  line.delivered_quantity_delta,
  line.accepted_quantity_delta,
  line.rejected_quantity_delta
from public.correction_notes note
join public.purchase_receipt_correction_lines line
  on line.correction_note_id = note.id
where note.correction_kind = 'PURCHASE_RECEIPT'

union all

select
  note.id as correction_id,
  note.correction_kind,
  'RETURN'::text as source_kind,
  note.correction_no,
  note.status,
  note.reason,
  note.posted_at,
  note.original_return_note_id as source_parent_id,
  line.original_return_line_id as source_line_id,
  line.return_quantity_delta as delta_quantity,
  null::bigint as delivered_quantity_delta,
  null::bigint as accepted_quantity_delta,
  null::bigint as rejected_quantity_delta
from public.correction_notes note
join public.return_correction_lines line
  on line.correction_note_id = note.id
where note.correction_kind = 'RETURN'

union all

select
  note.id as correction_id,
  note.correction_kind,
  'HR_ISSUE'::text as source_kind,
  note.correction_no,
  note.status,
  note.reason,
  note.posted_at,
  note.original_hr_request_id as source_parent_id,
  line.original_issue_line_id as source_line_id,
  line.issue_quantity_delta as delta_quantity,
  null::bigint as delivered_quantity_delta,
  null::bigint as accepted_quantity_delta,
  null::bigint as rejected_quantity_delta
from public.correction_notes note
join public.issue_correction_lines line
  on line.correction_note_id = note.id
where note.correction_kind = 'HR_ISSUE'

union all

select
  note.id as correction_id,
  note.correction_kind,
  'SHIPMENT'::text as source_kind,
  note.correction_no,
  note.status,
  note.reason,
  note.posted_at,
  note.original_warehouse_shipment_id as source_parent_id,
  line.original_shipment_line_id as source_line_id,
  line.transfer_quantity_delta as delta_quantity,
  null::bigint as delivered_quantity_delta,
  null::bigint as accepted_quantity_delta,
  null::bigint as rejected_quantity_delta
from public.correction_notes note
join public.warehouse_transfer_correction_lines line
  on line.correction_note_id = note.id
where note.correction_kind = 'WAREHOUSE_TRANSFER'
  and note.original_warehouse_shipment_id is not null

union all

select
  note.id as correction_id,
  note.correction_kind,
  'REPLENISHMENT'::text as source_kind,
  note.correction_no,
  note.status,
  note.reason,
  note.posted_at,
  note.original_replenishment_request_id as source_parent_id,
  line.original_replenishment_line_id as source_line_id,
  line.transfer_quantity_delta as delta_quantity,
  null::bigint as delivered_quantity_delta,
  null::bigint as accepted_quantity_delta,
  null::bigint as rejected_quantity_delta
from public.correction_notes note
join public.warehouse_transfer_correction_lines line
  on line.correction_note_id = note.id
where note.correction_kind = 'WAREHOUSE_TRANSFER'
  and note.original_replenishment_request_id is not null

union all

select
  note.id as correction_id,
  note.correction_kind,
  'STOCKTAKE'::text as source_kind,
  note.correction_no,
  note.status,
  note.reason,
  note.posted_at,
  note.original_stocktake_id as source_parent_id,
  line.original_stocktake_line_id as source_line_id,
  line.counted_quantity_delta as delta_quantity,
  null::bigint as delivered_quantity_delta,
  null::bigint as accepted_quantity_delta,
  null::bigint as rejected_quantity_delta
from public.correction_notes note
join public.stocktake_correction_lines line
  on line.correction_note_id = note.id
where note.correction_kind = 'STOCKTAKE';

revoke all on table public.v_correction_history from public, anon, authenticated;
grant select on public.v_correction_history to authenticated;
