-- Shape the actionable overview summaries into one read response.
-- Activity and audit history intentionally remain deferred browser reads.
-- This view is read-only; all workflow and inventory authority stays in the
-- existing protected RPCs and append-only source tables.

create or replace view public.v_overview_core
with (security_invoker = true)
as
select
  'current'::text as snapshot_key,
  coalesce((
    select jsonb_agg(to_jsonb(source_row) order by source_row.item_code)
    from (
      select item_code, item_name, available_to_request_quantity,
        combined_on_hand_quantity, active_reserved_quantity
      from public.v_item_availability
      order by item_code
      limit 300
    ) source_row
  ), '[]'::jsonb) as availability,
  coalesce((
    select jsonb_agg(to_jsonb(source_row) order by source_row.created_at desc)
    from (
      select request_id, request_no, status, distribution_date, created_at,
        requested_transfer_quantity
      from public.v_hr_request_item_totals
      order by created_at desc
      limit 300
    ) source_row
  ), '[]'::jsonb) as hr_requests,
  coalesce((
    select jsonb_agg(to_jsonb(source_row) order by source_row.distribution_date)
    from (
      select shipment_id, shipment_no, request_no, distribution_date,
        needs_warehouse_attention
      from public.v_pending_warehouse_shipments
      order by distribution_date
      limit 300
    ) source_row
  ), '[]'::jsonb) as shipments,
  coalesce((
    select jsonb_agg(to_jsonb(source_row) order by source_row.remaining_to_accept desc)
    from (
      select purchase_order_id, po_no, ordered_quantity, accepted_to_date,
        remaining_to_accept
      from public.v_purchase_order_receipt_progress
      order by remaining_to_accept desc
      limit 300
    ) source_row
  ), '[]'::jsonb) as receipts;

revoke all on table public.v_overview_core from public, anon, authenticated;
grant select on public.v_overview_core to authenticated;
