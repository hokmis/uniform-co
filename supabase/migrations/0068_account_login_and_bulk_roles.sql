-- Separate the human login name from the optional contact email and allow
-- SYSTEM_ADMIN to create or replace an account's role set atomically.

alter table public.app_accounts
  add column if not exists login_name text;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conname = 'app_accounts_login_name_format'
      and conrelid = 'public.app_accounts'::regclass
  ) then
    alter table public.app_accounts
      add constraint app_accounts_login_name_format
      check (login_name is null or login_name ~ '^[a-z0-9][a-z0-9._-]{2,49}$');
  end if;
end;
$$;

create unique index if not exists app_accounts_login_name_unique
  on public.app_accounts (lower(login_name))
  where login_name is not null;

comment on column public.app_accounts.login_name is
  'Case-normalized human login name. NULL only identifies a legacy email-login account until SYSTEM_ADMIN assigns a login name.';
comment on column public.app_accounts.email_snapshot is
  'Optional business contact email snapshot. It is not the Supabase Auth login identifier.';

create or replace function public.create_account_with_roles(
  p_auth_user_id uuid,
  p_login_name text,
  p_display_name text,
  p_email_snapshot text,
  p_role_codes text[],
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
  normalized_login_name text := lower(btrim(coalesce(p_login_name, '')));
  normalized_roles text[];
begin
  actor_id := private.require_system_admin();
  perform pg_advisory_xact_lock(hashtextextended('uniform-co:active-admin-guard', 0));

  select coalesce(array_agg(distinct normalized_role order by normalized_role), array[]::text[])
    into normalized_roles
  from (
    select upper(btrim(role_code)) as normalized_role
    from pg_catalog.unnest(coalesce(p_role_codes, array[]::text[])) as roles(role_code)
  ) normalized;

  if p_auth_user_id is null
     or normalized_login_name !~ '^[a-z0-9][a-z0-9._-]{2,49}$'
     or btrim(coalesce(p_display_name, '')) = ''
     or cardinality(normalized_roles) = 0
     or btrim(coalesce(p_reason, '')) = ''
     or btrim(coalesce(p_idempotency_key, '')) = '' then
    raise exception 'Account creation fields are invalid' using errcode = '22023';
  end if;
  if exists (
    select 1 from pg_catalog.unnest(normalized_roles) as roles(role_code)
    where role_code not in ('SYSTEM_ADMIN', 'HR', 'WAREHOUSE', 'PROCUREMENT', 'CEO', 'DEMAND_COORDINATOR')
  ) then
    raise exception 'Account role is invalid' using errcode = '22023';
  end if;
  if not exists (select 1 from auth.users u where u.id = p_auth_user_id) then
    raise exception 'The Auth user does not exist' using errcode = '22023';
  end if;

  canonical_fingerprint := encode(digest(jsonb_build_object(
    'auth_user_id', p_auth_user_id,
    'login_name', normalized_login_name,
    'display_name', left(btrim(p_display_name), 200),
    'email_snapshot', nullif(left(btrim(coalesce(p_email_snapshot, '')), 320), ''),
    'role_codes', to_jsonb(normalized_roles),
    'reason', left(btrim(p_reason), 500)
  )::text, 'sha256'), 'hex');
  if p_request_fingerprint is distinct from canonical_fingerprint then
    raise exception 'Account creation fingerprint mismatch' using errcode = '40001';
  end if;

  insert into public.operation_commands (
    operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id
  ) values (
    'ADMIN_CREATE_ACCOUNT_V2', p_idempotency_key, canonical_fingerprint, actor_id
  ) on conflict (operation_code, idempotency_key) do nothing;

  select * into command_row
  from public.operation_commands
  where operation_code = 'ADMIN_CREATE_ACCOUNT_V2'
    and idempotency_key = p_idempotency_key
  for update;
  if command_row.actor_account_id <> actor_id
     or command_row.canonical_request_fingerprint <> canonical_fingerprint then
    raise exception 'Account creation idempotency conflict' using errcode = '40001';
  end if;
  if command_row.status = 'SUCCEEDED' then
    select * into account_row from public.app_accounts where id = command_row.result_entity_id;
    return account_row;
  end if;
  if command_row.status <> 'IN_PROGRESS' then
    raise exception 'Account creation command is not retryable' using errcode = '55000';
  end if;
  if exists (select 1 from public.app_accounts where auth_user_id = p_auth_user_id) then
    raise exception 'Auth user is already bound to an app account' using errcode = '23505';
  end if;

  insert into public.app_accounts (auth_user_id, login_name, display_name, email_snapshot)
  values (
    p_auth_user_id,
    normalized_login_name,
    left(btrim(p_display_name), 200),
    nullif(left(btrim(coalesce(p_email_snapshot, '')), 320), '')
  )
  returning * into account_row;

  insert into public.user_roles (account_id, role_code)
  select account_row.id, role_code::public.app_role
  from pg_catalog.unnest(normalized_roles) as roles(role_code);

  insert into public.account_auth_binding_events (
    account_id, old_auth_user_id, new_auth_user_id, reason,
    rebound_by_account_id, execution_channel
  ) values (
    account_row.id, null, p_auth_user_id, left(btrim(p_reason), 500),
    actor_id, 'AUTHENTICATED'
  );

  perform private.append_audit_event(
    actor_id, 'ACCOUNT_CREATED', 'app_accounts', account_row.id,
    null,
    jsonb_build_object('account', to_jsonb(account_row), 'role_codes', to_jsonb(normalized_roles)),
    left(btrim(p_reason), 500), null, p_idempotency_key,
    jsonb_build_object('execution_channel', 'AUTHENTICATED')
  );

  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'app_accounts',
      result_entity_id = account_row.id, succeeded_at = now()
  where id = command_row.id;
  return account_row;
end;
$$;

create or replace function public.update_account_profile_v2(
  p_account_id uuid,
  p_login_name text,
  p_display_name text,
  p_email_snapshot text,
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
  normalized_login_name text := lower(btrim(coalesce(p_login_name, '')));
begin
  actor_id := private.require_system_admin();
  if p_account_id is null
     or normalized_login_name !~ '^[a-z0-9][a-z0-9._-]{2,49}$'
     or btrim(coalesce(p_display_name, '')) = ''
     or btrim(coalesce(p_reason, '')) = ''
     or btrim(coalesce(p_idempotency_key, '')) = '' then
    raise exception 'Account profile fields are invalid' using errcode = '22023';
  end if;

  canonical_fingerprint := encode(digest(jsonb_build_object(
    'account_id', p_account_id,
    'login_name', normalized_login_name,
    'display_name', left(btrim(p_display_name), 200),
    'email_snapshot', nullif(left(btrim(coalesce(p_email_snapshot, '')), 320), ''),
    'reason', left(btrim(p_reason), 500)
  )::text, 'sha256'), 'hex');
  if p_request_fingerprint is distinct from canonical_fingerprint then
    raise exception 'Account profile fingerprint mismatch' using errcode = '40001';
  end if;

  insert into public.operation_commands (
    operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id
  ) values (
    'ADMIN_UPDATE_ACCOUNT_PROFILE_V2', p_idempotency_key, canonical_fingerprint, actor_id
  ) on conflict (operation_code, idempotency_key) do nothing;
  select * into command_row
  from public.operation_commands
  where operation_code = 'ADMIN_UPDATE_ACCOUNT_PROFILE_V2'
    and idempotency_key = p_idempotency_key
  for update;
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

  select * into account_row from public.app_accounts where id = p_account_id for update;
  if not found then raise exception 'Account does not exist' using errcode = '22023'; end if;
  before_account := account_row;
  update public.app_accounts
  set login_name = normalized_login_name,
      display_name = left(btrim(p_display_name), 200),
      email_snapshot = nullif(left(btrim(coalesce(p_email_snapshot, '')), 320), '')
  where id = p_account_id
  returning * into account_row;

  perform private.append_audit_event(
    actor_id, 'ACCOUNT_PROFILE_UPDATED', 'app_accounts', account_row.id,
    to_jsonb(before_account), to_jsonb(account_row), left(btrim(p_reason), 500),
    null, p_idempotency_key, jsonb_build_object('execution_channel', 'AUTHENTICATED')
  );
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'app_accounts',
      result_entity_id = account_row.id, succeeded_at = now()
  where id = command_row.id;
  return account_row;
end;
$$;

create or replace function public.replace_account_roles(
  p_account_id uuid,
  p_role_codes text[],
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
  normalized_roles text[];
  before_roles jsonb;
  after_roles jsonb;
  active_admin_count integer;
begin
  actor_id := private.require_system_admin();
  perform pg_advisory_xact_lock(hashtextextended('uniform-co:active-admin-guard', 0));

  select coalesce(array_agg(distinct normalized_role order by normalized_role), array[]::text[])
    into normalized_roles
  from (
    select upper(btrim(role_code)) as normalized_role
    from pg_catalog.unnest(coalesce(p_role_codes, array[]::text[])) as roles(role_code)
  ) normalized;

  if p_account_id is null
     or cardinality(normalized_roles) = 0
     or btrim(coalesce(p_reason, '')) = ''
     or btrim(coalesce(p_idempotency_key, '')) = '' then
    raise exception 'Account role fields are invalid' using errcode = '22023';
  end if;
  if exists (
    select 1 from pg_catalog.unnest(normalized_roles) as roles(role_code)
    where role_code not in ('SYSTEM_ADMIN', 'HR', 'WAREHOUSE', 'PROCUREMENT', 'CEO', 'DEMAND_COORDINATOR')
  ) then
    raise exception 'Account role is invalid' using errcode = '22023';
  end if;

  canonical_fingerprint := encode(digest(jsonb_build_object(
    'account_id', p_account_id,
    'role_codes', to_jsonb(normalized_roles),
    'reason', left(btrim(p_reason), 500)
  )::text, 'sha256'), 'hex');
  if p_request_fingerprint is distinct from canonical_fingerprint then
    raise exception 'Account role fingerprint mismatch' using errcode = '40001';
  end if;

  insert into public.operation_commands (
    operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id
  ) values (
    'ADMIN_REPLACE_ACCOUNT_ROLES', p_idempotency_key, canonical_fingerprint, actor_id
  ) on conflict (operation_code, idempotency_key) do nothing;
  select * into command_row
  from public.operation_commands
  where operation_code = 'ADMIN_REPLACE_ACCOUNT_ROLES'
    and idempotency_key = p_idempotency_key
  for update;
  if command_row.actor_account_id <> actor_id
     or command_row.canonical_request_fingerprint <> canonical_fingerprint then
    raise exception 'Account role idempotency conflict' using errcode = '40001';
  end if;
  if command_row.status = 'SUCCEEDED' then
    select * into account_row from public.app_accounts where id = command_row.result_entity_id;
    return account_row;
  end if;
  if command_row.status <> 'IN_PROGRESS' then
    raise exception 'Account role command is not retryable' using errcode = '55000';
  end if;

  select * into account_row from public.app_accounts where id = p_account_id for update;
  if not found or not account_row.is_active then
    raise exception 'Only active accounts can receive roles' using errcode = '55000';
  end if;
  select coalesce(jsonb_agg(r.role_code order by r.role_code), '[]'::jsonb)
    into before_roles
  from public.user_roles r where r.account_id = p_account_id;

  if exists (
    select 1 from public.user_roles
    where account_id = p_account_id and role_code = 'SYSTEM_ADMIN'
  ) and not ('SYSTEM_ADMIN' = any(normalized_roles)) then
    select count(*) into active_admin_count
    from public.app_accounts a
    join public.user_roles r on r.account_id = a.id
    where a.is_active and r.role_code = 'SYSTEM_ADMIN';
    if active_admin_count <= 1 then
      raise exception 'Cannot remove the last active SYSTEM_ADMIN' using errcode = '55000';
    end if;
  end if;

  delete from public.user_roles where account_id = p_account_id;
  insert into public.user_roles (account_id, role_code)
  select p_account_id, role_code::public.app_role
  from pg_catalog.unnest(normalized_roles) as roles(role_code);

  if not ('DEMAND_COORDINATOR' = any(normalized_roles)) then
    delete from public.coordinator_scopes where account_id = p_account_id;
  end if;

  select coalesce(jsonb_agg(r.role_code order by r.role_code), '[]'::jsonb)
    into after_roles
  from public.user_roles r where r.account_id = p_account_id;
  perform private.append_audit_event(
    actor_id, 'ACCOUNT_ROLES_REPLACED', 'user_roles', p_account_id,
    before_roles, after_roles, left(btrim(p_reason), 500), null, p_idempotency_key,
    jsonb_build_object('execution_channel', 'AUTHENTICATED')
  );
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'app_accounts',
      result_entity_id = account_row.id, succeeded_at = now()
  where id = command_row.id;
  return account_row;
end;
$$;

revoke all on function public.create_account_with_roles(uuid, text, text, text, text[], text, text, text) from public, anon;
revoke all on function public.update_account_profile_v2(uuid, text, text, text, text, text, text) from public, anon;
revoke all on function public.replace_account_roles(uuid, text[], text, text, text) from public, anon;
grant execute on function public.create_account_with_roles(uuid, text, text, text, text[], text, text, text) to authenticated;
grant execute on function public.update_account_profile_v2(uuid, text, text, text, text, text, text) to authenticated;
grant execute on function public.replace_account_roles(uuid, text[], text, text, text) to authenticated;
