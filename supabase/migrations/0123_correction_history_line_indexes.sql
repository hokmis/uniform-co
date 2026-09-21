-- Read-path indexes for the unified correction history view.
-- The browser filters v_correction_history by source_line_id and joins the
-- source line back to correction_note_id. These indexes are additive and
-- repeatable; they do not change workflow, RLS, append-only, or posting rules.
-- purchase_receipt_correction_lines already has the equivalent index in 0100.

create index if not exists return_correction_lines_source_read_idx
  on public.return_correction_lines (original_return_line_id, correction_note_id);

create index if not exists issue_correction_lines_source_read_idx
  on public.issue_correction_lines (original_issue_line_id, correction_note_id);

create index if not exists warehouse_transfer_correction_lines_shipment_source_read_idx
  on public.warehouse_transfer_correction_lines (original_shipment_line_id, correction_note_id)
  where original_shipment_line_id is not null;

create index if not exists warehouse_transfer_correction_lines_replenishment_source_read_idx
  on public.warehouse_transfer_correction_lines (original_replenishment_line_id, correction_note_id)
  where original_replenishment_line_id is not null;

create index if not exists stocktake_correction_lines_source_read_idx
  on public.stocktake_correction_lines (original_stocktake_line_id, correction_note_id);
