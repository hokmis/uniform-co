-- Consolidate the warehouse queue read path without changing workflow writes.
-- The view remains security-invoker so the existing base-table RLS policies
-- decide which HR requests, replenishment requests, and draft shipments are visible.

create or replace view public.v_warehouse_shipment_queue
with (security_invoker = true)
as
select
  'HR_REQUEST:' || request_row.id::text as queue_key,
  request_row.id,
  'HR_REQUEST'::text as source,
  request_row.request_no,
  request_row.distribution_date::text as distribution_date,
  request_row.row_version,
  shipment_row.id as shipment_id,
  shipment_row.shipment_no,
  shipment_row.status as shipment_status,
  shipment_row.created_by as shipment_created_by
from public.hr_requests request_row
left join public.warehouse_shipments shipment_row
  on shipment_row.hr_request_id = request_row.id
 and shipment_row.status = 'DRAFT'
where request_row.status = 'SUBMITTED'

union all

select
  'REPLENISHMENT:' || replenishment_row.id::text as queue_key,
  replenishment_row.id,
  'REPLENISHMENT'::text as source,
  replenishment_row.request_no,
  coalesce(replenishment_row.submitted_at, replenishment_row.created_at)::text as distribution_date,
  replenishment_row.row_version,
  null::uuid as shipment_id,
  null::text as shipment_no,
  null::text as shipment_status,
  null::uuid as shipment_created_by
from public.replenishment_requests replenishment_row
where replenishment_row.status = 'SUBMITTED';

revoke all on table public.v_warehouse_shipment_queue from public, anon, authenticated;
grant select on public.v_warehouse_shipment_queue to authenticated;
