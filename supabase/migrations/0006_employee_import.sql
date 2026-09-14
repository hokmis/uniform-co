-- Employee master import: validate the complete batch before any upsert.

create table public.employee_import_batches (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  source_filename text,
  status text not null default 'PREPARING' check (status in ('PREPARING', 'APPLIED', 'FAILED')),
  row_count integer not null default 0 check (row_count >= 0),
  error_count integer not null default 0 check (error_count >= 0),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  applied_by uuid references public.app_accounts(id),
  error_message text
);

create table public.employee_import_rows (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.employee_import_batches(id),
  row_number integer not null check (row_number > 1),
  employee_no text not null,
  employee_name text not null,
  institution_code text not null,
  department_code text not null,
  employment_status text not null,
  status text not null check (status in ('VALIDATED', 'ERROR')),
  error_code text,
  error_message text,
  unique (batch_id, row_number)
);

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
  row_no integer := 1;
  import_error_count integer := 0;
  import_row_count integer := 0;
  employee_no text;
  employee_name text;
  institution_code text;
  department_code text;
  employment_status text;
  error_code text;
  error_message text;
  seen_employee_nos text[] := '{}'::text[];
  target_institution_id uuid;
  target_department_id uuid;
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
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'Employee import rows must be a non-empty JSON array';
  end if;
  if jsonb_array_length(p_rows) > 10000 then
    raise exception 'Employee import is limited to 10000 rows per batch';
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
        where d.institution_id = target_institution_id
          and d.code = department_code and d.is_active;
        if target_department_id is null then
          error_code := 'DEPARTMENT_NOT_FOUND';
          error_message := '部門不存在、跨機構或已停用';
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
        department_code, employment_status, status, error_code, error_message
      ) values (
        batch_row.id, row_no, employee_no, employee_name, institution_code,
        department_code, employment_status, 'ERROR', error_code, error_message
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
    where d.institution_id = target_institution_id and d.code = row_value ->> 'department_code' and d.is_active;
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

revoke all on function public.apply_employee_import(text, jsonb, text, text) from public, anon;
grant execute on function public.apply_employee_import(text, jsonb, text, text) to authenticated;

alter table public.employee_import_batches enable row level security;
alter table public.employee_import_rows enable row level security;
create policy employee_import_batches_read on public.employee_import_batches
  for select to authenticated using (private.has_role('HR'));
create policy employee_import_rows_read on public.employee_import_rows
  for select to authenticated using (private.has_role('HR'));
revoke all on table public.employee_import_batches, public.employee_import_rows from public, anon, authenticated;
grant select on public.employee_import_batches, public.employee_import_rows to authenticated;
