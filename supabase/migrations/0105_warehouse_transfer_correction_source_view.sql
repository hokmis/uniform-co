-- Consolidate the completed transfer source catalog without moving workflow
-- writes or locking rules out of the existing correction RPCs.
-- security_invoker keeps the source table RLS policies authoritative.

create or replace view public.v_warehouse_transfer_correction_sources
with (security_invoker = true)
as
select
  'SHIPMENT:' || shipment_line.id::text as source_key,
  'SHIPMENT'::text as source_kind,
  shipment_line.id as line_id,
  shipment_row.id as parent_id,
  shipment_row.shipment_no as parent_no,
  shipment_line.item_code_snapshot as item_code,
  shipment_line.item_name_snapshot as item_name,
  shipment_line.actual_transfer_quantity as actual_quantity,
  shipment_line.requested_transfer_quantity_snapshot as requested_quantity
from public.warehouse_shipments shipment_row
join public.warehouse_shipment_lines shipment_line
  on shipment_line.shipment_id = shipment_row.id
where shipment_row.status = 'POSTED'
  and shipment_line.actual_transfer_quantity is not null

union all

select
  'REPLENISHMENT:' || replenishment_line.id::text as source_key,
  'REPLENISHMENT'::text as source_kind,
  replenishment_line.id as line_id,
  replenishment_row.id as parent_id,
  replenishment_row.request_no as parent_no,
  replenishment_line.item_code_snapshot as item_code,
  replenishment_line.item_name_snapshot as item_name,
  replenishment_line.actual_transfer_quantity as actual_quantity,
  replenishment_line.requested_quantity as requested_quantity
from public.replenishment_requests replenishment_row
join public.replenishment_request_lines replenishment_line
  on replenishment_line.request_id = replenishment_row.id
where replenishment_row.status = 'SHIPPED'
  and replenishment_line.actual_transfer_quantity is not null;

revoke all on table public.v_warehouse_transfer_correction_sources
from public, anon, authenticated;
grant select on public.v_warehouse_transfer_correction_sources to authenticated;
