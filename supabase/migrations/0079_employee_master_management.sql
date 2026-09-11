begin;

create or replace function public.save_employee_master(
  p_employee_id uuid,
  p_employee_no text,
  p_name text,
  p_institution_code text,
  p_department_code text,
  p_employment_status text,
  p_job_title text,
  p_hire_date date,
  p_termination_date date,
  p_note text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.employees
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  existing_row public.employees;
  result_row public.employees;
  target_institution_id uuid;
  target_department_id uuid;
  normalized_employee_no text := btrim(coalesce(p_employee_no, ''));
  normalized_employee_name text := btrim(coalesce(p_name, ''));
  normalized_institution_code text := btrim(coalesce(p_institution_code, ''));
  normalized_department_code text := btrim(coalesce(p_department_code, ''));
  normalized_employment_status text := upper(btrim(coalesce(p_employment_status, '')));
  normalized_job_title text := nullif(btrim(coalesce(p_job_title, '')), '');
  normalized_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  current_account := private.current_account_id();
  if auth.uid() is null
     or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null
     or not private.has_role('HR') then
    raise exception using errcode = '42501', message = 'HR role is required';
  end if;
  if normalized_employee_no = '' or normalized_employee_name = '' or normalized_institution_code = '' or normalized_department_code = ''
     or normalized_employment_status not in ('ACTIVE', 'INACTIVE')
     or length(normalized_employee_no) > 100 or length(normalized_employee_name) > 255
     or length(normalized_institution_code) > 100 or length(normalized_department_code) > 100
     or length(coalesce(normalized_job_title, '')) > 255 or length(coalesce(normalized_note, '')) > 4000
     or btrim(coalesce(p_idempotency_key, '')) = ''
     or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'Employee master fields are invalid' using errcode = '22023';
  end if;
  if normalized_employee_no ~ '^[=+\-@]' or normalized_employee_name ~ '^[=+\-@]'
     or normalized_institution_code ~ '^[=+\-@]' or normalized_department_code ~ '^[=+\-@]'
     or coalesce(normalized_job_title, '') ~ '^[=+\-@]' or coalesce(normalized_note, '') ~ '^[=+\-@]'
     or normalized_employee_no ~ E'[\t\r\n]' or normalized_employee_name ~ E'[\t\r\n]'
     or normalized_institution_code ~ E'[\t\r\n]' or normalized_department_code ~ E'[\t\r\n]'
     or coalesce(normalized_job_title, '') ~ E'[\t\r\n]' then
    raise exception 'Employee master text contains unsafe characters' using errcode = '22023';
  end if;
  if normalized_employment_status = 'ACTIVE' and p_termination_date is not null then
    raise exception 'Active employee cannot have a termination date' using errcode = '22023';
  end if;
  if p_hire_date is not null and p_termination_date is not null and p_termination_date < p_hire_date then
    raise exception 'Termination date cannot be earlier than hire date' using errcode = '22023';
  end if;

  select i.id into target_institution_id
  from public.institutions i
  where i.code = normalized_institution_code and (i.is_active or normalized_employment_status = 'INACTIVE');
  if target_institution_id is null then
    raise exception 'Institution does not exist or is inactive' using errcode = '23503';
  end if;
  select d.id into target_department_id
  from public.departments d
  where d.institution_id = target_institution_id and d.code = normalized_department_code
    and (d.is_active or normalized_employment_status = 'INACTIVE');
  if target_department_id is null then
    raise exception 'Department does not exist, belongs to another institution, or is inactive' using errcode = '23503';
  end if;

  insert into public.operation_commands (
    operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id
  ) values (
    'SAVE_EMPLOYEE_MASTER', btrim(p_idempotency_key), btrim(p_request_fingerprint), current_account
  ) on conflict (operation_code, idempotency_key) do nothing;
  select * into command_row from public.operation_commands
  where operation_code = 'SAVE_EMPLOYEE_MASTER' and idempotency_key = btrim(p_idempotency_key)
  for update;
  if command_row.actor_account_id <> current_account
     or command_row.canonical_request_fingerprint <> btrim(p_request_fingerprint) then
    raise exception 'idempotency key conflicts with another request' using errcode = '40001';
  end if;
  if command_row.status = 'SUCCEEDED' and command_row.result_entity_id is not null then
    select * into result_row from public.employees where id = command_row.result_entity_id;
    return result_row;
  end if;
  if command_row.status <> 'IN_PROGRESS' then
    raise exception 'Employee master command is not retryable' using errcode = '55000';
  end if;

  if p_employee_id is null then
    if exists (
      select 1 from public.employees employee
      where employee.employee_no = normalized_employee_no
    ) then
      raise exception 'Employee number already exists; load the existing employee before editing' using errcode = '23505';
    end if;
    insert into public.employees (
      employee_no, name, institution_id, department_id, employment_status,
      job_title, hire_date, termination_date, note
    ) values (
      normalized_employee_no, normalized_employee_name, target_institution_id, target_department_id, normalized_employment_status,
      normalized_job_title, p_hire_date, p_termination_date, normalized_note
    ) returning * into result_row;
  else
    select * into existing_row
    from public.employees employee
    where employee.id = p_employee_id
    for update;
    if existing_row.id is null then
      raise exception 'Employee does not exist' using errcode = 'P0002';
    end if;
    if existing_row.employee_no <> normalized_employee_no then
      raise exception 'Employee number is immutable after creation' using errcode = '22023';
    end if;
    update public.employees
    set name = normalized_employee_name,
        institution_id = target_institution_id,
        department_id = target_department_id,
        employment_status = normalized_employment_status,
        job_title = normalized_job_title,
        hire_date = p_hire_date,
        termination_date = p_termination_date,
        note = normalized_note
    where id = existing_row.id
    returning * into result_row;
  end if;

  perform private.append_audit_event(
    current_account,
    case when existing_row.id is null then 'EMPLOYEE_CREATED' else 'EMPLOYEE_UPDATED' end,
    'employees',
    result_row.id,
    case when existing_row.id is null then null else to_jsonb(existing_row) end,
    to_jsonb(result_row),
    null,
    command_row.id,
    null,
    jsonb_build_object('source', 'employee-management')
  );
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'employees',
      result_entity_id = result_row.id, succeeded_at = now()
  where id = command_row.id;
  return result_row;
end;
$$;

create or replace function public.record_employee_master_export(
  p_row_count integer,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  event_id uuid;
begin
  current_account := private.current_account_id();
  if auth.uid() is null
     or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null
     or not private.has_role('HR') then
    raise exception using errcode = '42501', message = 'HR role is required';
  end if;
  if p_row_count is null or p_row_count < 0 or p_row_count > 10000
     or btrim(coalesce(p_idempotency_key, '')) = ''
     or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'Employee export fields are invalid' using errcode = '22023';
  end if;
  insert into public.operation_commands (
    operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id
  ) values (
    'EXPORT_EMPLOYEE_MASTER', btrim(p_idempotency_key), btrim(p_request_fingerprint), current_account
  ) on conflict (operation_code, idempotency_key) do nothing;
  select * into command_row from public.operation_commands
  where operation_code = 'EXPORT_EMPLOYEE_MASTER' and idempotency_key = btrim(p_idempotency_key)
  for update;
  if command_row.actor_account_id <> current_account
     or command_row.canonical_request_fingerprint <> btrim(p_request_fingerprint) then
    raise exception 'idempotency key conflicts with another request' using errcode = '40001';
  end if;
  if command_row.status = 'SUCCEEDED' and command_row.result_entity_id is not null then
    return command_row.result_entity_id;
  end if;
  if command_row.status <> 'IN_PROGRESS' then
    raise exception 'Employee export command is not retryable' using errcode = '55000';
  end if;
  event_id := private.append_audit_event(
    current_account, 'EMPLOYEE_MASTER_EXPORTED', 'employees', null, null,
    jsonb_build_object('row_count', p_row_count, 'request_fingerprint', btrim(p_request_fingerprint)),
    null, command_row.id, null, jsonb_build_object('source', 'employee-management')
  );
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'audit_events',
      result_entity_id = event_id, succeeded_at = now()
  where id = command_row.id;
  return event_id;
end;
$$;

revoke all on function public.save_employee_master(uuid, text, text, text, text, text, text, date, date, text, text, text) from public, anon;
grant execute on function public.save_employee_master(uuid, text, text, text, text, text, text, date, date, text, text, text) to authenticated;
revoke all on function public.record_employee_master_export(integer, text, text) from public, anon;
grant execute on function public.record_employee_master_export(integer, text, text) to authenticated;

commit;
