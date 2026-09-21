-- Shape HR warehouse shipment draft lines and request snapshots in one read.
-- Posting remains owned by post_warehouse_shipment(_with_lines) and still
-- revalidates every quantity, source version, role and inventory lock.

create index if not exists warehouse_shipment_lines_shipment_item_read_idx
  on public.warehouse_shipment_lines (shipment_id, item_id);

create or replace view public.v_warehouse_shipment_lines
with (security_invoker = true)
as
select
  shipment_line.id,
  shipment_line.shipment_id,
  shipment_line.item_id,
  shipment_line.hr_request_item_id,
  request_item.item_code_snapshot,
  request_item.item_name_snapshot,
  request_item.unit_snapshot,
  shipment_line.requested_transfer_quantity_snapshot,
  shipment_line.maximum_transfer_quantity_snapshot,
  shipment_line.actual_transfer_quantity,
  shipment_line.short_ship_reason_code
from public.warehouse_shipment_lines shipment_line
left join public.hr_request_items request_item
  on request_item.id = shipment_line.hr_request_item_id;

revoke all on table public.v_warehouse_shipment_lines from public, anon, authenticated;
grant select on public.v_warehouse_shipment_lines to authenticated;
