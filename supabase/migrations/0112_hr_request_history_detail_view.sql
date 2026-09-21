-- Consolidate selected HR request detail rows without multiplying item/issue/reservation data.
-- security_invoker keeps the underlying table RLS policies authoritative.
create or replace view public.v_hr_request_history_detail
with (security_invoker = true)
as
select
  request_item.request_id,
  'ITEM'::text as detail_kind,
  request_item.id as detail_id,
  request_item.item_id,
  request_item.item_code_snapshot,
  request_item.item_name_snapshot,
  request_item.unit_snapshot,
  request_item.issue_quantity,
  request_item.increase_quantity,
  request_item.requested_transfer_quantity,
  null::integer as line_no,
  null::text as employee_no_snapshot,
  null::text as employee_name_snapshot,
  null::text as institution_code_snapshot,
  null::text as department_code_snapshot,
  null::text as size_snapshot,
  null::bigint as quantity,
  null::text as reservation_status,
  null::timestamptz as closed_at
from public.hr_request_items request_item

union all

select
  issue_line.request_id,
  'ISSUE'::text as detail_kind,
  issue_line.id as detail_id,
  issue_line.item_id,
  issue_line.item_code_snapshot,
  issue_line.item_name_snapshot,
  issue_line.unit_snapshot,
  null::bigint as issue_quantity,
  null::bigint as increase_quantity,
  null::bigint as requested_transfer_quantity,
  issue_line.line_no,
  issue_line.employee_no_snapshot,
  issue_line.employee_name_snapshot,
  issue_line.institution_code_snapshot,
  issue_line.department_code_snapshot,
  issue_line.size_snapshot,
  issue_line.quantity,
  null::text as reservation_status,
  null::timestamptz as closed_at
from public.hr_issue_lines issue_line

union all

select
  reservation.source_hr_request_id as request_id,
  'RESERVATION'::text as detail_kind,
  reservation.id as detail_id,
  reservation.item_id,
  null::text as item_code_snapshot,
  null::text as item_name_snapshot,
  null::text as unit_snapshot,
  null::bigint as issue_quantity,
  null::bigint as increase_quantity,
  null::bigint as requested_transfer_quantity,
  null::integer as line_no,
  null::text as employee_no_snapshot,
  null::text as employee_name_snapshot,
  null::text as institution_code_snapshot,
  null::text as department_code_snapshot,
  null::text as size_snapshot,
  reservation.quantity,
  reservation.status as reservation_status,
  reservation.closed_at
from public.inventory_reservations reservation;

revoke all on table public.v_hr_request_history_detail from public, anon, authenticated;
grant select on public.v_hr_request_history_detail to authenticated;
