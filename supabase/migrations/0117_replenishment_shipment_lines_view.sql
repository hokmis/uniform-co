-- Shape submitted replenishment line reads at the database seam.
-- The view keeps the existing RLS policies authoritative and lets the
-- warehouse workbench read line snapshots plus current GENERAL availability
-- in one round trip. Posting still rechecks stock and locks in its RPC.

create index if not exists replenishment_request_lines_request_item_read_idx
  on public.replenishment_request_lines (request_id, item_id);

create or replace view public.v_replenishment_shipment_lines
with (security_invoker = true)
as
select
  line.id,
  line.request_id,
  line.item_id,
  line.requested_quantity,
  line.item_code_snapshot,
  line.item_name_snapshot,
  line.unit_snapshot,
  line.maximum_transfer_quantity_snapshot,
  line.actual_transfer_quantity,
  line.short_ship_reason_code,
  coalesce(availability.general_on_hand_quantity, 0)::bigint as general_on_hand_quantity,
  case
    when line.maximum_transfer_quantity_snapshot is null
      then least(line.requested_quantity, coalesce(availability.general_on_hand_quantity, 0)::bigint)
    else line.maximum_transfer_quantity_snapshot
  end::bigint as effective_maximum_transfer_quantity
from public.replenishment_request_lines line
join public.replenishment_requests request_row
  on request_row.id = line.request_id
 and request_row.status = 'SUBMITTED'
left join public.v_item_availability availability
  on availability.item_id = line.item_id;

revoke all on table public.v_replenishment_shipment_lines from public, anon, authenticated;
grant select on public.v_replenishment_shipment_lines to authenticated;
