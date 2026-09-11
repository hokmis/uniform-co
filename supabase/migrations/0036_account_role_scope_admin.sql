-- SYSTEM_ADMIN account, role and coordinator-scope administration.
-- Supabase Auth invitations are intentionally sent outside SQL; this migration
-- creates the durable business profile only after the invited auth UUID exists.

create table if not exists public.account_auth_binding_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.app_accounts(id),
  old_auth_user_id uuid,
  new_auth_user_id uuid,
  reason text not null check (btrim(reason) <> ''),
  rebound_at timestamptz not null default now(),
  rebound_by_account_id uuid references public.app_accounts(id),
  db_role_snapshot name not null default session_user,
  recovery_ticket text,
  execution_channel text not null default 'AUTHENTICATED'
    check (execution_channel in ('AUTHENTICATED', 'MAINTENANCE'))
);

create index if not exists account_auth_binding_events_account_idx
  on public.account_auth_binding_events (account_id, rebound_at desc);

create or replace function private.prevent_account_binding_event_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  raise exception 'Account auth binding history is append-only' using errcode = '55000';
end;
$$;

drop trigger if exists account_auth_binding_events_append_only
  on public.account_auth_binding_events;
create trigger account_auth_binding_events_append_only
before update or delete on public.account_auth_binding_events
for each row execute function private.prevent_account_binding_event_mutation();

alter table public.account_auth_binding_events enable row level security;
drop policy if exists account_auth_binding_events_admin_read on public.account_auth_binding_events;
create policy account_auth_binding_events_admin_read on public.account_auth_binding_events
for select to authenticated using (private.has_role('SYSTEM_ADMIN'));

revoke all on table public.account_auth_binding_events from public, anon, authenticated;
grant select on public.account_auth_binding_events to authenticated;
revoke all on function private.prevent_account_binding_event_mutation() from public, anon, authenticated;

drop policy if exists app_accounts_system_admin_read on public.app_accounts;
create policy app_accounts_system_admin_read on public.app_accounts
for select to authenticated using (private.has_role('SYSTEM_ADMIN'));
drop policy if exists user_roles_system_admin_read on public.user_roles;
create policy user_roles_system_admin_read on public.user_roles
for select to authenticated using (private.has_role('SYSTEM_ADMIN'));
drop policy if exists coordinator_scopes_system_admin_read on public.coordinator_scopes;
create policy coordinator_scopes_system_admin_read on public.coordinator_scopes
for select to authenticated using (private.has_role('SYSTEM_ADMIN'));

create or replace function private.require_system_admin()
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  account_id uuid;
begin
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' then
    raise exception using errcode = '42501', message = 'Authenticated account is required';
  end if;
  account_id := private.current_account_id();
  if account_id is null or not private.has_role('SYSTEM_ADMIN') then
    raise exception using errcode = '42501', message = 'SYSTEM_ADMIN role is required';
  end if;
  return account_id;
end;
$$;
revoke all on function private.require_system_admin() from public, anon, authenticated;

create or replace function public.create_account_profile(
  p_auth_user_id uuid,
  p_display_name text,
  p_email_snapshot text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.app_accounts
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  actor_id uuid;
  command_row public.operation_commands;
  account_row public.app_accounts;
  canonical_fingerprint text;
begin
  actor_id := private.require_system_admin();
  if p_auth_user_id is null or btrim(coalesce(p_display_name, '')) = ''
     or btrim(coalesce(p_idempotency_key, '')) = '' then
    raise exception 'Account profile fields are invalid' using errcode = '22023';
  end if;
  if not exists (select 1 from auth.users u where u.id = p_auth_user_id) then
    raise exception 'The invited Auth user does not exist' using errcode = '22023';
  end if;
  canonical_fingerprint := encode(digest(jsonb_build_object(
    'auth_user_id', p_auth_user_id,
    'display_name', left(btrim(p_display_name), 200),
    'email_snapshot', nullif(left(btrim(coalesce(p_email_snapshot, '')), 320), '')
  )::text, 'sha256'), 'hex');
  if p_request_fingerprint is distinct from canonical_fingerprint then
    raise exception 'Account profile fingerprint mismatch' using errcode = '40001';
  end if;
  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('ADMIN_CREATE_ACCOUNT', p_idempotency_key, canonical_fingerprint, actor_id)
  on conflict (operation_code, idempotency_key) do nothing;
  select * into command_row from public.operation_commands
  where operation_code = 'ADMIN_CREATE_ACCOUNT' and idempotency_key = p_idempotency_key for update;
  if command_row.actor_account_id <> actor_id
     or command_row.canonical_request_fingerprint <> canonical_fingerprint then
    raise exception 'Account profile idempotency conflict' using errcode = '40001';
  end if;
  if command_row.status = 'SUCCEEDED' then
    select * into account_row from public.app_accounts where id = command_row.result_entity_id;
    return account_row;
  end if;
  if command_row.status <> 'IN_PROGRESS' then
    raise exception 'Account profile command is not retryable' using errcode = '55000';
  end if;
  if exists (select 1 from public.app_accounts where auth_user_id = p_auth_user_id) then
    raise exception 'Auth user is already bound to an app account' using errcode = '23505';
  end if;
  insert into public.app_accounts (auth_user_id, display_name, email_snapshot)
  values (p_auth_user_id, left(btrim(p_display_name), 200), nullif(left(btrim(coalesce(p_email_snapshot, '')), 320), ''))
  returning * into account_row;
  insert into public.account_auth_binding_events (account_id, old_auth_user_id, new_auth_user_id, reason, rebound_by_account_id, execution_channel)
  values (account_row.id, null, p_auth_user_id, '初始帳號綁定', actor_id, 'AUTHENTICATED');
  perform private.append_audit_event(
    actor_id, 'ACCOUNT_CREATED', 'app_accounts', account_row.id,
    null, to_jsonb(account_row), '建立業務帳號與初始 Auth 綁定', null, p_idempotency_key,
    jsonb_build_object('execution_channel', 'AUTHENTICATED')
  );
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'app_accounts', result_entity_id = account_row.id, succeeded_at = now()
  where id = command_row.id;
  return account_row;
end;
$$;

create or replace function public.set_account_status(
  p_account_id uuid,
  p_is_active boolean,
  p_reason text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.app_accounts
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  actor_id uuid;
  command_row public.operation_commands;
  account_row public.app_accounts;
  before_account public.app_accounts;
  canonical_fingerprint text;
  active_admin_count integer;
begin
  actor_id := private.require_system_admin();
  perform pg_advisory_xact_lock(hashtextextended('uniform-co:active-admin-guard', 0));
  if p_account_id is null or p_is_active is null or btrim(coalesce(p_reason, '')) = ''
     or btrim(coalesce(p_idempotency_key, '')) = '' then
    raise exception 'Account status fields are invalid' using errcode = '22023';
  end if;
  canonical_fingerprint := encode(digest(jsonb_build_object(
    'account_id', p_account_id, 'is_active', p_is_active, 'reason', left(btrim(p_reason), 500)
  )::text, 'sha256'), 'hex');
  if p_request_fingerprint is distinct from canonical_fingerprint then
    raise exception 'Account status fingerprint mismatch' using errcode = '40001';
  end if;
  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('ADMIN_SET_ACCOUNT_STATUS', p_idempotency_key, canonical_fingerprint, actor_id)
  on conflict (operation_code, idempotency_key) do nothing;
  select * into command_row from public.operation_commands
  where operation_code = 'ADMIN_SET_ACCOUNT_STATUS' and idempotency_key = p_idempotency_key for update;
  if command_row.actor_account_id <> actor_id or command_row.canonical_request_fingerprint <> canonical_fingerprint then
    raise exception 'Account status idempotency conflict' using errcode = '40001';
  end if;
  if command_row.status = 'SUCCEEDED' then
    select * into account_row from public.app_accounts where id = command_row.result_entity_id;
    return account_row;
  end if;
  if command_row.status <> 'IN_PROGRESS' then raise exception 'Account status command is not retryable' using errcode = '55000'; end if;
  select * into account_row from public.app_accounts where id = p_account_id for update;
  if not found then raise exception 'Account does not exist' using errcode = '22023'; end if;
  before_account := account_row;
  if not p_is_active and exists (select 1 from public.user_roles where account_id = p_account_id and role_code = 'SYSTEM_ADMIN') then
    select count(*) into active_admin_count
    from public.app_accounts a join public.user_roles r on r.account_id = a.id
    where a.is_active and r.role_code = 'SYSTEM_ADMIN';
    if active_admin_count <= 1 then raise exception 'Cannot disable the last active SYSTEM_ADMIN' using errcode = '55000'; end if;
  end if;
  update public.app_accounts set is_active = p_is_active where id = p_account_id returning * into account_row;
  perform private.append_audit_event(
    actor_id, 'ACCOUNT_STATUS_CHANGED', 'app_accounts', account_row.id,
    to_jsonb(before_account), to_jsonb(account_row), left(btrim(p_reason), 500), null, p_idempotency_key,
    jsonb_build_object('execution_channel', 'AUTHENTICATED')
  );
  update public.operation_commands set status = 'SUCCEEDED', result_entity_type = 'app_accounts', result_entity_id = account_row.id, succeeded_at = now() where id = command_row.id;
  return account_row;
end;
$$;

create or replace function public.set_account_role(
  p_account_id uuid,
  p_role_code text,
  p_is_enabled boolean,
  p_reason text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.app_accounts
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  actor_id uuid;
  command_row public.operation_commands;
  account_row public.app_accounts;
  canonical_fingerprint text;
  active_admin_count integer;
  before_role_data jsonb;
  removed_scopes jsonb;
  normalized_role text := upper(btrim(coalesce(p_role_code, '')));
begin
  actor_id := private.require_system_admin();
  perform pg_advisory_xact_lock(hashtextextended('uniform-co:active-admin-guard', 0));
  if p_account_id is null or normalized_role not in ('SYSTEM_ADMIN', 'HR', 'WAREHOUSE', 'PROCUREMENT', 'CEO', 'DEMAND_COORDINATOR')
     or p_is_enabled is null or btrim(coalesce(p_reason, '')) = '' or btrim(coalesce(p_idempotency_key, '')) = '' then
    raise exception 'Account role fields are invalid' using errcode = '22023';
  end if;
  canonical_fingerprint := encode(digest(jsonb_build_object(
    'account_id', p_account_id, 'role_code', normalized_role, 'is_enabled', p_is_enabled,
    'reason', left(btrim(p_reason), 500)
  )::text, 'sha256'), 'hex');
  if p_request_fingerprint is distinct from canonical_fingerprint then raise exception 'Account role fingerprint mismatch' using errcode = '40001'; end if;
  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('ADMIN_SET_ACCOUNT_ROLE', p_idempotency_key, canonical_fingerprint, actor_id)
  on conflict (operation_code, idempotency_key) do nothing;
  select * into command_row from public.operation_commands where operation_code = 'ADMIN_SET_ACCOUNT_ROLE' and idempotency_key = p_idempotency_key for update;
  if command_row.actor_account_id <> actor_id or command_row.canonical_request_fingerprint <> canonical_fingerprint then raise exception 'Account role idempotency conflict' using errcode = '40001'; end if;
  if command_row.status = 'SUCCEEDED' then select * into account_row from public.app_accounts where id = command_row.result_entity_id; return account_row; end if;
  if command_row.status <> 'IN_PROGRESS' then raise exception 'Account role command is not retryable' using errcode = '55000'; end if;
  select * into account_row from public.app_accounts where id = p_account_id for update;
  if not found or not account_row.is_active then raise exception 'Only active accounts can receive roles' using errcode = '55000'; end if;
  select to_jsonb(r) into before_role_data
  from public.user_roles r
  where r.account_id = p_account_id and r.role_code = normalized_role::public.app_role;
  if not p_is_enabled and normalized_role = 'SYSTEM_ADMIN' then
    select count(*) into active_admin_count from public.app_accounts a join public.user_roles r on r.account_id = a.id where a.is_active and r.role_code = 'SYSTEM_ADMIN';
    if active_admin_count <= 1 then raise exception 'Cannot remove the last active SYSTEM_ADMIN' using errcode = '55000'; end if;
  end if;
  if p_is_enabled then
    insert into public.user_roles (account_id, role_code) values (p_account_id, normalized_role::public.app_role) on conflict do nothing;
  else
    delete from public.user_roles where account_id = p_account_id and role_code = normalized_role::public.app_role;
    if normalized_role = 'DEMAND_COORDINATOR' then
      select coalesce(jsonb_agg(to_jsonb(s) order by s.institution_id, s.department_id), '[]'::jsonb)
        into removed_scopes
        from public.coordinator_scopes s
        where s.account_id = p_account_id;
      delete from public.coordinator_scopes where account_id = p_account_id;
    end if;
  end if;
  perform private.append_audit_event(
    actor_id, 'ACCOUNT_ROLE_CHANGED', 'user_roles', p_account_id,
    before_role_data, jsonb_build_object('account_id', p_account_id, 'role_code', normalized_role, 'is_enabled', p_is_enabled, 'reason', left(btrim(p_reason), 500)),
    left(btrim(p_reason), 500), null, p_idempotency_key, jsonb_build_object('execution_channel', 'AUTHENTICATED')
  );
  if normalized_role = 'DEMAND_COORDINATOR' and removed_scopes is not null and jsonb_array_length(removed_scopes) > 0 then
    perform private.append_audit_event(
      actor_id, 'COORDINATOR_SCOPES_REVOKED_WITH_ROLE', 'coordinator_scopes', p_account_id,
      removed_scopes, '[]'::jsonb, left(btrim(p_reason), 500), null, p_idempotency_key,
      jsonb_build_object('execution_channel', 'AUTHENTICATED')
    );
  end if;
  update public.operation_commands set status = 'SUCCEEDED', result_entity_type = 'app_accounts', result_entity_id = account_row.id, succeeded_at = now() where id = command_row.id;
  return account_row;
end;
$$;

create or replace function public.set_coordinator_scope(
  p_account_id uuid,
  p_institution_id uuid,
  p_department_id uuid,
  p_is_enabled boolean,
  p_reason text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.coordinator_scopes
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  actor_id uuid;
  command_row public.operation_commands;
  scope_row public.coordinator_scopes;
  before_scope public.coordinator_scopes;
  canonical_fingerprint text;
begin
  actor_id := private.require_system_admin();
  perform pg_advisory_xact_lock(hashtextextended('uniform-co:active-admin-guard', 0));
  if p_account_id is null or p_institution_id is null or p_department_id is null or p_is_enabled is null
     or btrim(coalesce(p_reason, '')) = '' or btrim(coalesce(p_idempotency_key, '')) = '' then
    raise exception 'Coordinator scope fields are invalid' using errcode = '22023';
  end if;
  canonical_fingerprint := encode(digest(jsonb_build_object(
    'account_id', p_account_id, 'institution_id', p_institution_id, 'department_id', p_department_id,
    'is_enabled', p_is_enabled, 'reason', left(btrim(p_reason), 500)
  )::text, 'sha256'), 'hex');
  if p_request_fingerprint is distinct from canonical_fingerprint then raise exception 'Coordinator scope fingerprint mismatch' using errcode = '40001'; end if;
  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('ADMIN_SET_COORDINATOR_SCOPE', p_idempotency_key, canonical_fingerprint, actor_id)
  on conflict (operation_code, idempotency_key) do nothing;
  select * into command_row from public.operation_commands where operation_code = 'ADMIN_SET_COORDINATOR_SCOPE' and idempotency_key = p_idempotency_key for update;
  if command_row.actor_account_id <> actor_id or command_row.canonical_request_fingerprint <> canonical_fingerprint then raise exception 'Coordinator scope idempotency conflict' using errcode = '40001'; end if;
  if command_row.status = 'SUCCEEDED' then
    select * into scope_row from public.coordinator_scopes where account_id = p_account_id and institution_id = p_institution_id and department_id = p_department_id;
    return scope_row;
  end if;
  if command_row.status <> 'IN_PROGRESS' then raise exception 'Coordinator scope command is not retryable' using errcode = '55000'; end if;
  -- Scope changes and DEMAND_COORDINATOR role changes share the same lock and
  -- account row so a scope cannot survive role removal.
  perform 1 from public.app_accounts where id = p_account_id for update;
  if not found then raise exception 'Account does not exist' using errcode = '22023'; end if;
  select * into before_scope from public.coordinator_scopes
  where account_id = p_account_id and institution_id = p_institution_id and department_id = p_department_id
  for update;
  if p_is_enabled then
    if not exists (select 1 from public.app_accounts where id = p_account_id and is_active)
       or not exists (select 1 from public.user_roles where account_id = p_account_id and role_code = 'DEMAND_COORDINATOR') then
      raise exception 'Active DEMAND_COORDINATOR role is required' using errcode = '55000';
    end if;
    if not exists (select 1 from public.departments d where d.id = p_department_id and d.institution_id = p_institution_id and d.is_active and exists (select 1 from public.institutions i where i.id = d.institution_id and i.is_active)) then
      raise exception 'Active institution and department must match' using errcode = '22023';
    end if;
    insert into public.coordinator_scopes (account_id, institution_id, department_id)
    values (p_account_id, p_institution_id, p_department_id) on conflict do nothing;
    select * into scope_row from public.coordinator_scopes
    where account_id = p_account_id and institution_id = p_institution_id and department_id = p_department_id;
  else
    delete from public.coordinator_scopes where account_id = p_account_id and institution_id = p_institution_id and department_id = p_department_id;
    scope_row := null;
  end if;
  perform private.append_audit_event(
    actor_id, 'COORDINATOR_SCOPE_CHANGED', 'coordinator_scopes', p_account_id,
    to_jsonb(before_scope), case when p_is_enabled then to_jsonb(scope_row) else null end,
    left(btrim(p_reason), 500), null, p_idempotency_key, jsonb_build_object('execution_channel', 'AUTHENTICATED')
  );
  update public.operation_commands set status = 'SUCCEEDED', result_entity_type = 'coordinator_scopes', result_entity_id = p_account_id, succeeded_at = now() where id = command_row.id;
  return scope_row;
end;
$$;

create or replace function public.rebind_account_auth(
  p_account_id uuid,
  p_new_auth_user_id uuid,
  p_reason text,
  p_recovery_ticket text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.app_accounts
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  actor_id uuid;
  command_row public.operation_commands;
  account_row public.app_accounts;
  canonical_fingerprint text;
  old_auth_user_id uuid;
begin
  actor_id := private.require_system_admin();
  if p_account_id is null or p_account_id = actor_id
     or btrim(coalesce(p_reason, '')) = '' or btrim(coalesce(p_idempotency_key, '')) = '' then
    raise exception 'Account rebind fields are invalid' using errcode = '22023';
  end if;
  canonical_fingerprint := encode(digest(jsonb_build_object(
    'account_id', p_account_id, 'new_auth_user_id', p_new_auth_user_id,
    'reason', left(btrim(p_reason), 500), 'recovery_ticket', nullif(left(btrim(coalesce(p_recovery_ticket, '')), 200), '')
  )::text, 'sha256'), 'hex');
  if p_request_fingerprint is distinct from canonical_fingerprint then raise exception 'Account rebind fingerprint mismatch' using errcode = '40001'; end if;
  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('ADMIN_REBIND_ACCOUNT_AUTH', p_idempotency_key, canonical_fingerprint, actor_id)
  on conflict (operation_code, idempotency_key) do nothing;
  select * into command_row from public.operation_commands where operation_code = 'ADMIN_REBIND_ACCOUNT_AUTH' and idempotency_key = p_idempotency_key for update;
  if command_row.actor_account_id <> actor_id or command_row.canonical_request_fingerprint <> canonical_fingerprint then raise exception 'Account rebind idempotency conflict' using errcode = '40001'; end if;
  if command_row.status = 'SUCCEEDED' then select * into account_row from public.app_accounts where id = command_row.result_entity_id; return account_row; end if;
  if command_row.status <> 'IN_PROGRESS' then raise exception 'Account rebind command is not retryable' using errcode = '55000'; end if;
  if p_new_auth_user_id is not null and not exists (select 1 from auth.users where id = p_new_auth_user_id) then raise exception 'The new Auth user does not exist' using errcode = '22023'; end if;
  if p_new_auth_user_id is not null and exists (select 1 from public.app_accounts where auth_user_id = p_new_auth_user_id and id <> p_account_id) then raise exception 'The new Auth user is already bound' using errcode = '23505'; end if;
  select * into account_row from public.app_accounts where id = p_account_id for update;
  if not found then raise exception 'Account does not exist' using errcode = '22023'; end if;
  old_auth_user_id := account_row.auth_user_id;
  update public.app_accounts set auth_user_id = p_new_auth_user_id where id = p_account_id returning * into account_row;
  insert into public.account_auth_binding_events (account_id, old_auth_user_id, new_auth_user_id, reason, rebound_by_account_id, recovery_ticket, execution_channel)
  values (account_row.id, old_auth_user_id, p_new_auth_user_id, left(btrim(p_reason), 500), actor_id, nullif(left(btrim(coalesce(p_recovery_ticket, '')), 200), ''), 'AUTHENTICATED');
  perform private.append_audit_event(
    actor_id, 'ACCOUNT_AUTH_REBOUND', 'app_accounts', account_row.id,
    jsonb_build_object('account_id', account_row.id, 'auth_user_id', old_auth_user_id),
    jsonb_build_object('account_id', account_row.id, 'auth_user_id', p_new_auth_user_id),
    left(btrim(p_reason), 500), null, p_idempotency_key, jsonb_build_object('execution_channel', 'AUTHENTICATED')
  );
  update public.operation_commands set status = 'SUCCEEDED', result_entity_type = 'app_accounts', result_entity_id = account_row.id, succeeded_at = now() where id = command_row.id;
  return account_row;
end;
$$;

revoke all on function public.create_account_profile(uuid, text, text, text, text) from public, anon;
revoke all on function public.set_account_status(uuid, boolean, text, text, text) from public, anon;
revoke all on function public.set_account_role(uuid, text, boolean, text, text, text) from public, anon;
revoke all on function public.set_coordinator_scope(uuid, uuid, uuid, boolean, text, text, text) from public, anon;
revoke all on function public.rebind_account_auth(uuid, uuid, text, text, text, text) from public, anon;
grant execute on function public.create_account_profile(uuid, text, text, text, text) to authenticated;
grant execute on function public.set_account_status(uuid, boolean, text, text, text) to authenticated;
grant execute on function public.set_account_role(uuid, text, boolean, text, text, text) to authenticated;
grant execute on function public.set_coordinator_scope(uuid, uuid, uuid, boolean, text, text, text) to authenticated;
grant execute on function public.rebind_account_auth(uuid, uuid, text, text, text, text) to authenticated;
