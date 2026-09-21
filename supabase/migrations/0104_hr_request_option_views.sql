-- Shape the HR request form's option reads at the database seam.
-- security_invoker keeps the existing base-table RLS policies authoritative.

create or replace view public.v_hr_request_employee_options
with (security_invoker = true)
as
select
  e.id,
  e.employee_no,
  e.name,
  e.institution_id,
  i.code as institution_code,
  i.name as institution_name,
  e.department_id,
  d.code as department_code,
  d.name as department_name
from public.employees e
join public.institutions i
  on i.id = e.institution_id
 and i.is_active
join public.departments d
  on d.id = e.department_id
 and d.institution_id = e.institution_id
 and d.is_active
where e.employment_status = 'ACTIVE';

create or replace view public.v_hr_request_item_options
with (security_invoker = true)
as
select
  availability.item_id as id,
  availability.item_code,
  availability.item_name,
  availability.size,
  availability.unit,
  availability.hr_on_hand_quantity,
  availability.general_on_hand_quantity,
  availability.active_reserved_quantity
from public.v_item_availability availability
where availability.is_active;

revoke all on table public.v_hr_request_employee_options, public.v_hr_request_item_options
from public, anon, authenticated;
grant select on public.v_hr_request_employee_options, public.v_hr_request_item_options to authenticated;
