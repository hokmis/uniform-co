-- Consolidate seasonal demand scope and registered lines into one read seam.
-- Tagged UNION ALL avoids the employee x item row explosion of a joined scope view.
-- security_invoker keeps the base-table RLS policies authoritative.
create or replace view public.v_seasonal_demand_workspace
with (security_invoker = true)
as
select
  'EMPLOYEE'::text as scope_kind,
  scope_employee.campaign_id,
  scope_employee.employee_id,
  scope_employee.employee_no_snapshot,
  scope_employee.employee_name_snapshot,
  null::uuid as item_id,
  null::text as item_code_snapshot,
  null::text as item_name_snapshot,
  null::text as size_snapshot,
  null::text as unit_snapshot,
  null::uuid as demand_line_id,
  null::text as demand_employee_no_snapshot,
  null::text as demand_employee_name_snapshot,
  null::text as demand_item_code_snapshot,
  null::text as demand_item_name_snapshot,
  null::text as demand_size_snapshot,
  null::bigint as demand_quantity,
  null::boolean as demand_hr_modified,
  null::text as demand_hr_note,
  null::timestamptz as demand_updated_at
from public.seasonal_campaign_employees scope_employee

union all

select
  'ITEM'::text as scope_kind,
  scope_item.campaign_id,
  null::uuid as employee_id,
  null::text as employee_no_snapshot,
  null::text as employee_name_snapshot,
  scope_item.item_id,
  scope_item.item_code_snapshot,
  scope_item.item_name_snapshot,
  scope_item.size_snapshot,
  scope_item.unit_snapshot,
  null::uuid as demand_line_id,
  null::text as demand_employee_no_snapshot,
  null::text as demand_employee_name_snapshot,
  null::text as demand_item_code_snapshot,
  null::text as demand_item_name_snapshot,
  null::text as demand_size_snapshot,
  null::bigint as demand_quantity,
  null::boolean as demand_hr_modified,
  null::text as demand_hr_note,
  null::timestamptz as demand_updated_at
from public.seasonal_campaign_items scope_item

union all

select
  'DEMAND'::text as scope_kind,
  demand_line.campaign_id,
  demand_line.employee_id,
  null::text as employee_no_snapshot,
  null::text as employee_name_snapshot,
  demand_line.item_id,
  null::text as item_code_snapshot,
  null::text as item_name_snapshot,
  null::text as size_snapshot,
  null::text as unit_snapshot,
  demand_line.id as demand_line_id,
  demand_line.employee_no_snapshot as demand_employee_no_snapshot,
  demand_line.employee_name_snapshot as demand_employee_name_snapshot,
  demand_line.item_code_snapshot as demand_item_code_snapshot,
  demand_line.item_name_snapshot as demand_item_name_snapshot,
  demand_line.size_snapshot as demand_size_snapshot,
  demand_line.quantity as demand_quantity,
  demand_line.hr_modified as demand_hr_modified,
  demand_line.hr_note as demand_hr_note,
  demand_line.updated_at as demand_updated_at
from public.seasonal_demand_lines demand_line;

revoke all on table public.v_seasonal_demand_workspace from public, anon, authenticated;
grant select on public.v_seasonal_demand_workspace to authenticated;
