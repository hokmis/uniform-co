begin;

-- A used institution remains addressable by old documents and scopes. Only
-- an entirely unused row can be removed; do not cascade business history.
create or replace function public.delete_institution(
  p_institution_id uuid,
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
  institution_row public.institutions;
begin
  current_account := private.current_account_id();
  if auth.uid() is null
     or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null then
    raise exception using errcode = '42501', message = 'Authenticated account is required';
  end if;

  if p_institution_id is null
     or btrim(coalesce(p_idempotency_key, '')) = ''
     or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception using errcode = '22023', message = 'Institution delete fields are invalid';
  end if;

  if not (private.has_role('SYSTEM_ADMIN') or private.has_role('HR')) then
    raise exception using errcode = '42501', message = 'Role cannot delete institutions';
  end if;

  insert into public.operation_commands (
    operation_code,
    idempotency_key,
    canonical_request_fingerprint,
    actor_account_id
  ) values (
    'DELETE_INSTITUTION',
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
    where operation_code = 'DELETE_INSTITUTION'
      and idempotency_key = p_idempotency_key
    for update;

    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED'
       and command_row.result_entity_id = p_institution_id then
      return true;
    end if;
    raise exception using errcode = '40001', message = 'Institution delete is already in progress or failed';
  end if;

  select * into institution_row
  from public.institutions
  where id = p_institution_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Institution not found';
  end if;

  if exists (select 1 from public.departments where institution_id = p_institution_id)
     or exists (select 1 from public.employees where institution_id = p_institution_id)
     or exists (select 1 from public.coordinator_scopes where institution_id = p_institution_id)
     or exists (select 1 from public.erp_export_batches where institution_id_snapshot = p_institution_id)
     or exists (select 1 from public.hr_issue_lines where institution_id_snapshot = p_institution_id)
     or exists (select 1 from public.seasonal_campaign_employees where institution_id_snapshot = p_institution_id)
     or exists (select 1 from public.issue_correction_lines where institution_id_snapshot = p_institution_id) then
    raise exception using
      errcode = '23514',
      message = 'Institution cannot be deleted because department, employee, scope, or business history exists';
  end if;

  perform private.append_audit_event(
    current_account,
    'INSTITUTION_DELETED',
    'institutions',
    p_institution_id,
    to_jsonb(institution_row),
    null,
    null,
    command_row.id,
    null,
    jsonb_build_object('institution_code', institution_row.code)
  );

  begin
    delete from public.institutions where id = p_institution_id;
  exception
    when foreign_key_violation then
      raise exception using
        errcode = '23514',
        message = 'Institution cannot be deleted because related records exist';
  end;

  update public.operation_commands
  set status = 'SUCCEEDED',
      result_entity_type = 'institutions',
      result_entity_id = p_institution_id,
      succeeded_at = now()
  where id = command_row.id;

  return true;
end;
$$;

comment on function public.delete_institution(uuid, text, text)
  is 'Deletes an unused institution with idempotency and audit; departments, employees, scopes, history and other foreign keys block deletion.';

revoke all on function public.delete_institution(uuid, text, text) from public, anon;
grant execute on function public.delete_institution(uuid, text, text) to authenticated;

commit;
