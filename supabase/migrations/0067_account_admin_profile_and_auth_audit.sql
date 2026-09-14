-- Complete the in-app account administration seam.
--
-- app_accounts remains the durable business identity. Supabase Auth owns
-- credentials; this migration only stores the business profile changes and
-- an append-only audit event for server-side Auth Admin operations.

create or replace function public.update_account_profile(
  p_account_id uuid,
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
begin
  actor_id := private.require_system_admin();
  if p_account_id is null
     or btrim(coalesce(p_display_name, '')) = ''
     or btrim(coalesce(p_reason, '')) = ''
     or btrim(coalesce(p_idempotency_key, '')) = '' then
    raise exception 'Account profile fields are invalid' using errcode = '22023';
  end if;

  canonical_fingerprint := encode(digest(jsonb_build_object(
    'account_id', p_account_id,
    'display_name', left(btrim(p_display_name), 200),
    'email_snapshot', nullif(left(btrim(coalesce(p_email_snapshot, '')), 320), ''),
    'reason', left(btrim(p_reason), 500)
  )::text, 'sha256'), 'hex');
  if p_request_fingerprint is distinct from canonical_fingerprint then
    raise exception 'Account profile fingerprint mismatch' using errcode = '40001';
  end if;

  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('ADMIN_UPDATE_ACCOUNT_PROFILE', p_idempotency_key, canonical_fingerprint, actor_id)
  on conflict (operation_code, idempotency_key) do nothing;
  select * into command_row
  from public.operation_commands
  where operation_code = 'ADMIN_UPDATE_ACCOUNT_PROFILE'
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
  if not found then
    raise exception 'Account does not exist' using errcode = '22023';
  end if;
  before_account := account_row;
  update public.app_accounts
  set display_name = left(btrim(p_display_name), 200),
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

create or replace function public.record_account_security_event(
  p_account_id uuid,
  p_action text,
  p_reason text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  actor_id uuid;
  command_row public.operation_commands;
  event_id uuid;
  canonical_fingerprint text;
  normalized_action text := upper(btrim(coalesce(p_action, '')));
begin
  actor_id := private.require_system_admin();
  if p_account_id is null
     or normalized_action not in (
       'ACCOUNT_AUTH_CREATED',
       'ACCOUNT_PASSWORD_CHANGED',
       'ACCOUNT_AUTH_ENABLED',
       'ACCOUNT_AUTH_DISABLED',
       'ACCOUNT_AUTH_DELETED'
     )
     or btrim(coalesce(p_reason, '')) = ''
     or btrim(coalesce(p_idempotency_key, '')) = '' then
    raise exception 'Account security event fields are invalid' using errcode = '22023';
  end if;
  if not exists (select 1 from public.app_accounts where id = p_account_id) then
    raise exception 'Account does not exist' using errcode = '22023';
  end if;

  canonical_fingerprint := encode(digest(jsonb_build_object(
    'account_id', p_account_id,
    'action', normalized_action,
    'reason', left(btrim(p_reason), 500)
  )::text, 'sha256'), 'hex');
  if p_request_fingerprint is distinct from canonical_fingerprint then
    raise exception 'Account security event fingerprint mismatch' using errcode = '40001';
  end if;

  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('ADMIN_RECORD_ACCOUNT_SECURITY_EVENT', p_idempotency_key, canonical_fingerprint, actor_id)
  on conflict (operation_code, idempotency_key) do nothing;
  select * into command_row
  from public.operation_commands
  where operation_code = 'ADMIN_RECORD_ACCOUNT_SECURITY_EVENT'
    and idempotency_key = p_idempotency_key
  for update;
  if command_row.actor_account_id <> actor_id
     or command_row.canonical_request_fingerprint <> canonical_fingerprint then
    raise exception 'Account security event idempotency conflict' using errcode = '40001';
  end if;
  if command_row.status = 'SUCCEEDED' then
    return command_row.result_entity_id;
  end if;
  if command_row.status <> 'IN_PROGRESS' then
    raise exception 'Account security event command is not retryable' using errcode = '55000';
  end if;

  event_id := private.append_audit_event(
    actor_id, normalized_action, 'app_accounts', p_account_id,
    null, jsonb_build_object('managed_by', 'SERVER_AUTH_ADMIN'),
    left(btrim(p_reason), 500), null, p_idempotency_key,
    jsonb_build_object('execution_channel', 'SERVER_AUTH_ADMIN')
  );
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'audit_events',
      result_entity_id = event_id, succeeded_at = now()
  where id = command_row.id;
  return event_id;
end;
$$;

revoke all on function public.update_account_profile(uuid, text, text, text, text, text) from public, anon;
revoke all on function public.record_account_security_event(uuid, text, text, text, text) from public, anon;
grant execute on function public.update_account_profile(uuid, text, text, text, text, text) to authenticated;
grant execute on function public.record_account_security_event(uuid, text, text, text, text) to authenticated;
