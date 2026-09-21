-- Consolidate shipped HR issue correction sources.
-- security_invoker keeps the existing HR request and issue-line RLS policies.

create or replace view public.v_hr_issue_correction_sources
with (security_invoker = true)
as
select
  issue_line.id as line_id,
  request_row.id as request_id,
  request_row.request_no,
  request_row.status,
  request_row.distribution_date,
  issue_line.line_no,
  issue_line.employee_no_snapshot,
  issue_line.employee_name_snapshot,
  issue_line.item_code_snapshot as item_code,
  issue_line.item_name_snapshot as item_name,
  issue_line.quantity
from public.hr_requests request_row
join public.hr_issue_lines issue_line
  on issue_line.request_id = request_row.id
where request_row.status = 'SHIPPED';

revoke all on table public.v_hr_issue_correction_sources
from public, anon, authenticated;
grant select on public.v_hr_issue_correction_sources to authenticated;
