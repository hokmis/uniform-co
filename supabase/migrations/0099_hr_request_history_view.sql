-- Read path for the HR request history list.
-- Keep the view security-invoker so the existing table RLS policies remain
-- the authority for what HR/warehouse users can see.

create or replace view public.v_hr_request_history
with (security_invoker = true)
as
select
  r.id,
  r.request_no,
  r.status,
  r.distribution_date,
  r.row_version,
  r.created_at,
  r.submitted_at,
  r.shipped_at,
  r.cancelled_at,
  r.note,
  s.shipment_no,
  s.status as shipment_status,
  coalesce(sum(res.quantity) filter (where res.status = 'ACTIVE'), 0)::bigint
    as active_reserved_quantity
from public.hr_requests r
left join public.warehouse_shipments s on s.hr_request_id = r.id
left join public.inventory_reservations res on res.source_hr_request_id = r.id
group by
  r.id,
  r.request_no,
  r.status,
  r.distribution_date,
  r.row_version,
  r.created_at,
  r.submitted_at,
  r.shipped_at,
  r.cancelled_at,
  r.note,
  s.shipment_no,
  s.status;

revoke all on table public.v_hr_request_history from public, anon, authenticated;
grant select on public.v_hr_request_history to authenticated;

create index if not exists hr_requests_created_at_idx
  on public.hr_requests (created_at desc);

create index if not exists inventory_reservations_source_status_idx
  on public.inventory_reservations (source_hr_request_id, status)
  include (quantity);
