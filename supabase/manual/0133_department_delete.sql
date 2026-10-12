begin;

-- Hard-delete only an unused department. Historical references that store a
-- department UUID without a foreign key are checked explicitly as well.
create or replace function public.delete_department(
  p_department_id uuid,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  department_row public.departments;
begin
  current_account := private.current_account_id();
  if auth.uid() is null
     or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null then
    raise exception using errcode = '42501', message = 'Authenticated account is required';
  end if;

  if p_department_id is null
     or btrim(coalesce(p_idempotency_key, '')) = ''
     or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception using errcode = '22023', message = 'Department delete fields are invalid';
  end if;

  if not (private.has_role('SYSTEM_ADMIN') or private.has_role('HR')) then
    raise exception using errcode = '42501', message = 'Role cannot delete departments';
  end if;

  insert into public.operation_commands (
    operation_code,
    idempotency_key,
    canonical_request_fingerprint,
    actor_account_id
  ) values (
    'DELETE_DEPARTMENT',
    p_idempotency_key,
    p_request_fingerprint,
    current_account
  )
  on conflict on constraint operation_commands_operation_code_idempotency_key_key
  do nothing
  returning * into command_row;

  if command_row.id is null then
    select * into command_row
    from public.operation_commands
    where operation_code = 'DELETE_DEPARTMENT'
      and idempotency_key = p_idempotency_key
    for update;

    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED'
       and command_row.result_entity_id = p_department_id then
      return true;
    end if;
    raise exception using errcode = '40001', message = 'Department delete is already in progress or failed';
  end if;

  select * into department_row
  from public.departments
  where id = p_department_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Department not found';
  end if;

  if exists (select 1 from public.employees where department_id = p_department_id)
     or exists (select 1 from public.coordinator_scopes where department_id = p_department_id)
     or exists (select 1 from public.hr_issue_lines where department_id_snapshot = p_department_id)
     or exists (select 1 from public.seasonal_campaign_employees where department_id_snapshot = p_department_id)
     or exists (select 1 from public.issue_correction_lines where department_id_snapshot = p_department_id) then
    raise exception using
      errcode = '23514',
      message = 'Department cannot be deleted because employee, scope, or business history exists';
  end if;

  -- Keep a complete, immutable snapshot before removing the master row.
  perform private.append_audit_event(
    current_account,
    'DEPARTMENT_DELETED',
    'departments',
    p_department_id,
    to_jsonb(department_row),
    null,
    null,
    command_row.id,
    null,
    jsonb_build_object(
      'institution_id', department_row.institution_id,
      'department_code', department_row.code
    )
  );

  begin
    delete from public.departments where id = p_department_id;
  exception
    when foreign_key_violation then
      raise exception using
        errcode = '23514',
        message = 'Department cannot be deleted because related records exist';
  end;

  update public.operation_commands
  set status = 'SUCCEEDED',
      result_entity_type = 'departments',
      result_entity_id = p_department_id,
      succeeded_at = now()
  where id = command_row.id;

  return true;
end;
$$;

comment on function public.delete_department(uuid, text, text)
  is 'Deletes an unused department with idempotency and audit; employees, scopes, historical snapshots and other foreign keys block deletion.';

revoke all on function public.delete_department(uuid, text, text) from public, anon;
grant execute on function public.delete_department(uuid, text, text) to authenticated;

commit;
