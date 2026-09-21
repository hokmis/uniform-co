-- Shape the employee directory with organization snapshots into one read.
-- security_invoker keeps the existing employees/institutions/departments RLS
-- policies authoritative, including visibility of inactive historical rows.

create or replace view public.v_employee_directory
with (security_invoker = true)
as
select
  employee.id,
  employee.employee_no,
  employee.name,
  employee.institution_id,
  institution.code as institution_code,
  institution.name as institution_name,
  employee.department_id,
  department.code as department_code,
  department.name as department_name,
  employee.employment_status,
  employee.job_title,
  employee.hire_date,
  employee.termination_date,
  employee.note
from public.employees employee
left join public.institutions institution
  on institution.id = employee.institution_id
left join public.departments department
  on department.id = employee.department_id
 and department.institution_id = employee.institution_id;

revoke all on table public.v_employee_directory from public, anon, authenticated;
grant select on public.v_employee_directory to authenticated;
