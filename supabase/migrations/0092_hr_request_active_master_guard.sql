-- Reject a HR request when its employee organization became inactive after draft creation.
-- The UI filters these rows, but the state transition must be authoritative in the database.

create or replace function private.validate_hr_request_active_master_data()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  if old.status = 'DRAFT' and new.status = 'SUBMITTED' then
    if exists (
      select 1
      from public.hr_issue_lines l
      left join public.employees e on e.id = l.employee_id
      left join public.institutions i on i.id = e.institution_id
      left join public.departments d on d.id = e.department_id and d.institution_id = e.institution_id
      where l.request_id = new.id
        and (
          e.id is null
          or e.employment_status <> 'ACTIVE'
          or i.id is null
          or not i.is_active
          or d.id is null
          or not d.is_active
        )
    ) then
      raise exception 'HR request contains an inactive employee organization';
    end if;
  end if;
  return new;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_trigger t
    where t.tgrelid = 'public.hr_requests'::pg_catalog.regclass
      and t.tgname = 'hr_request_active_master_guard'
      and not t.tgisinternal
  ) then
    execute 'create trigger hr_request_active_master_guard
      before update of status on public.hr_requests
      for each row execute function private.validate_hr_request_active_master_data()';
  end if;
end;
$$;
