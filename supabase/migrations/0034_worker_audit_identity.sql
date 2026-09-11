-- Bind background job sessions to a stable app account for audit attribution.
-- The table is deployment-managed; no browser role can write or read it.

create table if not exists private.job_actor_bindings (
  db_role name primary key,
  account_id uuid not null references public.app_accounts(id),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

revoke all on table private.job_actor_bindings from public, anon, authenticated;

create or replace function private.execution_actor_id()
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, private
as $$
  select coalesce(
    private.current_account_id(),
    (
      select b.account_id
      from private.job_actor_bindings b
      join public.app_accounts a on a.id = b.account_id and a.is_active
      where b.db_role = session_user
        and b.is_active
    )
  )
$$;

revoke all on function private.execution_actor_id() from public, anon, authenticated;

create or replace function private.audit_business_row_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  actor_id uuid;
  row_id uuid;
begin
  actor_id := private.execution_actor_id();
  if actor_id is null then
    raise exception 'An authenticated account or bound job actor is required for audit' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    row_id := old.id;
  else
    row_id := new.id;
  end if;
  perform private.append_audit_event(
    actor_id,
    upper(tg_table_name) || '_' || lower(tg_op),
    tg_table_name,
    row_id,
    case when tg_op = 'INSERT' then null else to_jsonb(old) end,
    case when tg_op = 'DELETE' then null else to_jsonb(new) end,
    null,
    null,
    null,
    jsonb_build_object('execution_channel', case when private.current_account_id() is null then 'JOB' else 'AUTHENTICATED' end)
  );
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function private.audit_operation_command_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  actor_id uuid;
begin
  if tg_op = 'INSERT' then
    actor_id := coalesce(new.actor_account_id, private.execution_actor_id());
  elsif tg_op = 'DELETE' then
    actor_id := coalesce(old.actor_account_id, private.execution_actor_id());
  else
    actor_id := coalesce(new.actor_account_id, old.actor_account_id, private.execution_actor_id());
  end if;
  if actor_id is not null then
    perform private.append_audit_event(
      actor_id,
      case when tg_op = 'INSERT' then 'COMMAND_CREATED'
           when tg_op = 'DELETE' then 'COMMAND_DELETED'
           else 'COMMAND_STATUS_CHANGED' end,
      tg_table_name,
      coalesce(new.id, old.id),
      case when tg_op = 'INSERT' then null else to_jsonb(old) end,
      case when tg_op = 'DELETE' then null else to_jsonb(new) end,
      null,
      null,
      null,
      jsonb_build_object('execution_channel', case when private.current_account_id() is null then 'JOB' else 'AUTHENTICATED' end)
    );
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

-- The old overloads remain only as private implementation details for the
-- wrappers below. No role can invoke them directly, and wrappers derive both
-- actor and canonical fingerprint server-side.
revoke all on function public.finalize_storage_archive(text, uuid, text, text, text, text, text, text, timestamptz, uuid, text, text) from public, anon, authenticated, job_storage_cleanup;
revoke all on function public.record_storage_lifecycle_event(uuid, text, jsonb, uuid, text, text) from public, anon, authenticated, job_storage_cleanup;

create or replace function public.finalize_storage_archive(
  p_source_kind text,
  p_source_id uuid,
  p_original_storage_object_key text,
  p_source_sha256 text,
  p_archive_record_key text,
  p_archive_object_key text,
  p_archive_payload_sha256 text,
  p_manifest_sha256 text,
  p_verified_at timestamptz,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.storage_archive_records
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  actor_id uuid;
  canonical_fingerprint text;
begin
  if session_user <> 'job_storage_cleanup' then
    raise exception using errcode = '42501', message = 'job_storage_cleanup role is required';
  end if;
  actor_id := private.execution_actor_id();
  if actor_id is null then
    raise exception 'A bound archive worker actor is required' using errcode = '42501';
  end if;
  canonical_fingerprint := encode(digest(
    jsonb_build_object(
      'source_kind', p_source_kind,
      'source_id', p_source_id,
      'original_storage_object_key', p_original_storage_object_key,
      'source_sha256', p_source_sha256,
      'archive_record_key', p_archive_record_key,
      'archive_object_key', p_archive_object_key,
      'archive_payload_sha256', p_archive_payload_sha256,
      'manifest_sha256', p_manifest_sha256,
      'verified_at', p_verified_at
    )::text,
    'sha256'
  ), 'hex');
  if p_request_fingerprint is distinct from canonical_fingerprint then
    raise exception 'Canonical archive fingerprint mismatch' using errcode = 'P0001';
  end if;
  return public.finalize_storage_archive(
    p_source_kind, p_source_id, p_original_storage_object_key, p_source_sha256,
    p_archive_record_key, p_archive_object_key, p_archive_payload_sha256,
    p_manifest_sha256, p_verified_at, actor_id, p_idempotency_key,
    canonical_fingerprint
  );
end;
$$;

create or replace function public.record_storage_lifecycle_event(
  p_archive_record_id uuid,
  p_event_kind text,
  p_details jsonb,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.storage_object_lifecycle_events
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  actor_id uuid;
  canonical_fingerprint text;
begin
  if session_user <> 'job_storage_cleanup' then
    raise exception using errcode = '42501', message = 'job_storage_cleanup role is required';
  end if;
  actor_id := private.execution_actor_id();
  if actor_id is null then
    raise exception 'A bound archive worker actor is required' using errcode = '42501';
  end if;
  canonical_fingerprint := encode(digest(
    jsonb_build_object(
      'archive_record_id', p_archive_record_id,
      'event_kind', p_event_kind,
      'details', coalesce(p_details, '{}'::jsonb)
    )::text,
    'sha256'
  ), 'hex');
  if p_request_fingerprint is distinct from canonical_fingerprint then
    raise exception 'Canonical lifecycle fingerprint mismatch' using errcode = 'P0001';
  end if;
  return public.record_storage_lifecycle_event(
    p_archive_record_id, p_event_kind, p_details, actor_id,
    p_idempotency_key, canonical_fingerprint
  );
end;
$$;

revoke all on function public.finalize_storage_archive(text, uuid, text, text, text, text, text, text, timestamptz, text, text) from public, anon, authenticated;
revoke all on function public.record_storage_lifecycle_event(uuid, text, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.finalize_storage_archive(text, uuid, text, text, text, text, text, text, timestamptz, text, text) to job_storage_cleanup;
grant execute on function public.record_storage_lifecycle_event(uuid, text, jsonb, text, text) to job_storage_cleanup;
