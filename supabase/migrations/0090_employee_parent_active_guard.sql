-- Prevent active employees from becoming unusable because their institution or
-- department is deactivated after the employee master was created.

create or replace function private.reject_active_employee_parent_deactivation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  if old.is_active and not new.is_active then
    if tg_table_name = 'institutions'
       and exists (
         select 1
         from public.employees e
         where e.institution_id = old.id
           and e.employment_status = 'ACTIVE'
       ) then
      raise exception 'Cannot deactivate institution with active employees'
        using errcode = '23514';
    end if;

    if tg_table_name = 'departments'
       and exists (
         select 1
         from public.employees e
         where e.institution_id = old.institution_id
           and e.department_id = old.id
           and e.employment_status = 'ACTIVE'
       ) then
      raise exception 'Cannot deactivate department with active employees'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists reject_institution_deactivation_with_active_employees
  on public.institutions;
create trigger reject_institution_deactivation_with_active_employees
before update of is_active on public.institutions
for each row
execute function private.reject_active_employee_parent_deactivation();

drop trigger if exists reject_department_deactivation_with_active_employees
  on public.departments;
create trigger reject_department_deactivation_with_active_employees
before update of is_active on public.departments
for each row
execute function private.reject_active_employee_parent_deactivation();
