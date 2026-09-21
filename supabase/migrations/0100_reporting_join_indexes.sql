-- Read-path indexes for reporting joins and the dashboard activity feed.
-- These indexes are additive only: they do not change RLS, workflow state,
-- append-only guarantees, or the meaning of any business record.

create index if not exists inventory_balances_item_warehouse_read_idx
  on public.inventory_balances (item_id, warehouse_id)
  include (on_hand_quantity);

create index if not exists hr_issue_lines_request_item_read_idx
  on public.hr_issue_lines (request_id, item_id)
  include (quantity);

create index if not exists purchase_receipt_lines_order_line_read_idx
  on public.purchase_receipt_lines (purchase_order_line_id, receipt_id)
  include (delivered_quantity, accepted_quantity, rejected_quantity);

create index if not exists purchase_receipt_correction_lines_source_read_idx
  on public.purchase_receipt_correction_lines (original_receipt_line_id, correction_note_id)
  include (delivered_quantity_delta, accepted_quantity_delta, rejected_quantity_delta);

create index if not exists audit_events_occurred_at_read_idx
  on public.audit_events (occurred_at desc)
  include (action, entity_table, entity_id, actor_account_id);
