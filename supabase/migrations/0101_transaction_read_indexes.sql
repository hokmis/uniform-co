-- Read-path indexes for the transaction workbenches.
-- These indexes are additive and repeatable; they do not change workflow,
-- RLS, immutable-record, or posting semantics.

create index if not exists purchase_orders_open_po_no_idx
  on public.purchase_orders (po_no)
  where status in ('ORDERED', 'PARTIALLY_RECEIVED', 'REOPENED');

create index if not exists purchase_receipts_posted_receipt_no_idx
  on public.purchase_receipts (receipt_no desc)
  where status = 'POSTED';

create index if not exists hr_requests_shipped_distribution_date_idx
  on public.hr_requests (distribution_date desc)
  where status = 'SHIPPED';

create index if not exists return_notes_posted_id_idx
  on public.return_notes (id desc)
  where status = 'POSTED';

create index if not exists correction_notes_purchase_receipt_source_idx
  on public.correction_notes (original_purchase_receipt_id, id desc)
  where correction_kind = 'PURCHASE_RECEIPT';

create index if not exists correction_notes_return_note_source_idx
  on public.correction_notes (original_return_note_id, id desc)
  where correction_kind = 'RETURN';
