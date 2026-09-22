-- Migration 0123: Decouple employee department and institution foreign key constraints
-- Drops composite foreign key (department_id, institution_id) on employees
-- and replaces with independent foreign key on department_id.
-- Updates save_employee_master and apply_employee_import to allow arbitrary institution + department combinations.

begin;

-- 1. Drop composite foreign key from employees
alter table public.employees
  drop constraint if exists employees_department_id_institution_id_fkey;

-- 2. Ensure individual foreign key on department_id
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.employees'::regclass
      and conname = 'employees_department_id_fkey'
  ) then
    alter table public.employees
      add constraint employees_department_id_fkey
      foreign key (department_id) references public.departments(id);
  end if;
end $$;

-- 3. Update save_employee_master to decouple department resolution from institution
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

  -- Decoupled department lookup: find department by code, preferring same institution if available
  select d.id into target_department_id
  from public.departments d
  where d.code = normalized_department_code
    and (d.is_active or normalized_employment_status = 'INACTIVE')
  order by (d.institution_id = target_institution_id) desc, d.is_active desc
  limit 1;
  if target_department_id is null then
    raise exception 'Department does not exist or is inactive' using errcode = '23503';
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

-- 4. Update apply_employee_import to also allow decoupled department resolution
create or replace function public.apply_employee_import(
  p_source_filename text,
  p_rows jsonb,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.employee_import_batches
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  batch_row public.employee_import_batches;
  result_row public.employee_import_batches;
  row_value jsonb;
  row_no integer := 0;
  employee_no text;
  employee_name text;
  institution_code text;
  department_code text;
  employment_status text;
  target_institution_id uuid;
  target_department_id uuid;
  error_code text;
  error_message text;
  import_row_count integer := 0;
  import_error_count integer := 0;
  seen_employee_nos text[] := array[]::text[];
begin
  current_account := private.current_account_id();
  if auth.uid() is null
     or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null
     or not private.has_role('HR') then
    raise exception using errcode = '42501', message = 'HR role is required';
  end if;
  if btrim(coalesce(p_idempotency_key, '')) = ''
     or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'idempotency_key and request_fingerprint are required';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'p_rows must be a non-empty JSON array';
  end if;

  insert into public.operation_commands (
    operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id
  ) values (
    'APPLY_EMPLOYEE_IMPORT', p_idempotency_key, p_request_fingerprint, current_account
  ) on conflict (operation_code, idempotency_key) do nothing
  returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'APPLY_EMPLOYEE_IMPORT'
      and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' then
      select * into result_row from public.employee_import_batches where id = command_row.result_entity_id;
      return result_row;
    end if;
    raise exception using errcode = '40001', message = 'employee import is already in progress or failed';
  end if;

  insert into public.employee_import_batches (idempotency_key, source_filename, applied_by)
  values (p_idempotency_key, left(nullif(btrim(p_source_filename), ''), 255), current_account)
  returning * into batch_row;

  for row_value in select value from jsonb_array_elements(p_rows)
  loop
    row_no := row_no + 1;
    import_row_count := import_row_count + 1;
    employee_no := btrim(coalesce(row_value ->> 'employeeNo', ''));
    employee_name := btrim(coalesce(row_value ->> 'name', ''));
    institution_code := btrim(coalesce(row_value ->> 'institutionCode', ''));
    department_code := btrim(coalesce(row_value ->> 'departmentCode', ''));
    employment_status := upper(btrim(coalesce(row_value ->> 'employmentStatus', '')));
    error_code := null;
    error_message := null;

    if employee_no = '' or employee_name = '' or institution_code = '' or department_code = '' then
      error_code := 'EMPTY_REQUIRED';
      error_message := '工號、姓名、機構與部門不可空白';
    elsif employment_status not in ('ACTIVE', 'INACTIVE') then
      error_code := 'INVALID_STATUS';
      error_message := 'employment_status 必須是 ACTIVE 或 INACTIVE';
    elsif employee_no ~ '^[=+\-@]' or employee_name ~ '^[=+\-@]'
       or institution_code ~ '^[=+\-@]' or department_code ~ '^[=+\-@]' then
      error_code := 'FORMULA_CELL';
      error_message := '拒絕含公式前綴的主檔欄位';
    elsif employee_no = any(seen_employee_nos) then
      error_code := 'DUPLICATE_EMPLOYEE_NO';
      error_message := '同一批次工號重複';
    else
      select i.id into target_institution_id
      from public.institutions i
      where i.code = institution_code and i.is_active;
      if target_institution_id is null then
        error_code := 'INSTITUTION_NOT_FOUND';
        error_message := '機構不存在或已停用';
      else
        select d.id into target_department_id
        from public.departments d
        where d.code = department_code and d.is_active
        order by (d.institution_id = target_institution_id) desc
        limit 1;
        if target_department_id is null then
          error_code := 'DEPARTMENT_NOT_FOUND';
          error_message := '報局單位不存在或已停用';
        end if;
      end if;
    end if;

    if error_code is null then
      seen_employee_nos := array_append(seen_employee_nos, employee_no);
      insert into public.employee_import_rows (
        batch_id, row_number, employee_no, employee_name, institution_code,
        department_code, employment_status, status
      ) values (
        batch_row.id, row_no, employee_no, employee_name, institution_code,
        department_code, employment_status, 'VALIDATED'
      );
    else
      import_error_count := import_error_count + 1;
      insert into public.employee_import_rows (
        batch_id, row_number, employee_no, employee_name, institution_code,
        department_code, employment_status, error_code, error_message, status
      ) values (
        batch_row.id, row_no, employee_no, employee_name, institution_code,
        department_code, employment_status, error_code, error_message, 'ERROR'
      );
    end if;
  end loop;

  update public.employee_import_batches
  set row_count = import_row_count, error_count = import_error_count
  where id = batch_row.id;

  if import_error_count > 0 then
    update public.employee_import_batches
    set status = 'FAILED', completed_at = now(), error_message = '匯入批次含有驗證錯誤'
    where id = batch_row.id returning * into result_row;
    update public.operation_commands
    set status = 'RETRYABLE_FAILED', result_entity_type = 'employee_import_batches',
        result_entity_id = batch_row.id, last_error_code = 'VALIDATION_FAILED'
    where id = command_row.id;
    return result_row;
  end if;

  for row_value in
    select to_jsonb(r) from public.employee_import_rows r where r.batch_id = batch_row.id order by r.row_number
  loop
    select i.id into target_institution_id from public.institutions i
    where i.code = row_value ->> 'institution_code' and i.is_active;
    select d.id into target_department_id from public.departments d
    where d.code = row_value ->> 'department_code' and d.is_active
    order by (d.institution_id = target_institution_id) desc
    limit 1;
    update public.employees e
    set name = row_value ->> 'employee_name',
        institution_id = target_institution_id,
        department_id = target_department_id,
        employment_status = row_value ->> 'employment_status'
    where e.employee_no = row_value ->> 'employee_no';
    if not found then
      insert into public.employees (
        employee_no, name, institution_id, department_id, employment_status
      ) values (
        row_value ->> 'employee_no', row_value ->> 'employee_name',
        target_institution_id, target_department_id, row_value ->> 'employment_status'
      );
    end if;
  end loop;

  update public.employee_import_batches
  set status = 'APPLIED', completed_at = now()
  where id = batch_row.id returning * into result_row;
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'employee_import_batches',
      result_entity_id = batch_row.id, succeeded_at = now()
  where id = command_row.id;
  return result_row;
end;
$$;

revoke all on function public.save_employee_master(uuid, text, text, text, text, text, text, date, date, text, text, text) from public, anon;
grant execute on function public.save_employee_master(uuid, text, text, text, text, text, text, date, date, text, text, text) to authenticated;
revoke all on function public.apply_employee_import(text, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.apply_employee_import(text, jsonb, text, text) to authenticated;

commit;
