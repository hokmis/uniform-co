-- Read-path indexes for correction history workbenches.
-- These indexes are additive and repeatable; they do not change workflow,
-- RLS, append-only, or correction posting semantics.

create index if not exists correction_notes_hr_request_source_idx
  on public.correction_notes (original_hr_request_id, id desc)
  where correction_kind = 'HR_ISSUE';

create index if not exists correction_notes_stocktake_source_idx
  on public.correction_notes (original_stocktake_id, id desc)
  where correction_kind = 'STOCKTAKE';

create index if not exists correction_notes_warehouse_shipment_source_idx
  on public.correction_notes (original_warehouse_shipment_id, id desc)
  where correction_kind = 'WAREHOUSE_TRANSFER';

create index if not exists correction_notes_replenishment_source_idx
  on public.correction_notes (original_replenishment_request_id, id desc)
  where correction_kind = 'WAREHOUSE_TRANSFER';
