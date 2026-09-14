-- Append-only audit and storage archive controls.
-- This is a forward migration: do not edit already-applied migrations.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'job_storage_cleanup') then
    execute 'create role job_storage_cleanup noinherit nologin';
  end if;
end;
$$;

alter table public.master_import_batches
  add column if not exists storage_object_key text,
  add column if not exists file_sha256 text;
alter table public.master_import_batches
  add constraint master_import_batches_file_sha256_format
  check (file_sha256 is null or file_sha256 ~ '^[0-9a-fA-F]{64}$');

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default now(),
  actor_account_id uuid not null references public.app_accounts(id),
  action text not null check (btrim(action) <> ''),
  entity_table text not null check (btrim(entity_table) <> ''),
  entity_id uuid,
  before_data jsonb,
  after_data jsonb,
  reason text,
  request_id uuid,
  correlation_id text,
  client_metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(client_metadata) = 'object')
);

create table public.storage_archive_records (
  id uuid primary key default gen_random_uuid(),
  archive_record_key text not null unique check (btrim(archive_record_key) <> ''),
  erp_artifact_id uuid references public.erp_export_artifacts(id),
  document_artifact_id uuid references public.document_artifacts(id),
  import_batch_id uuid references public.master_import_batches(id),
  original_storage_object_key text not null check (btrim(original_storage_object_key) <> ''),
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-fA-F]{64}$'),
  archive_object_key text not null unique check (btrim(archive_object_key) <> ''),
  archive_payload_sha256 text not null check (archive_payload_sha256 ~ '^[0-9a-fA-F]{64}$'),
  manifest_sha256 text not null check (manifest_sha256 ~ '^[0-9a-fA-F]{64}$'),
  verified_at timestamptz not null,
  finalized_at timestamptz not null default now(),
  finalized_by uuid not null references public.app_accounts(id),
  check (num_nonnulls(erp_artifact_id, document_artifact_id, import_batch_id) = 1)
);

create table public.storage_object_lifecycle_events (
  id uuid primary key default gen_random_uuid(),
  archive_record_id uuid not null references public.storage_archive_records(id),
  event_kind text not null check (event_kind in ('PRODUCTION_REMOVED', 'RESTORED')),
  event_at timestamptz not null default now(),
  event_by uuid not null references public.app_accounts(id),
  details jsonb not null default '{}'::jsonb
    check (jsonb_typeof(details) = 'object')
);

create index storage_archive_records_erp_artifact_idx
  on public.storage_archive_records (erp_artifact_id)
  where erp_artifact_id is not null;
create index storage_archive_records_document_artifact_idx
  on public.storage_archive_records (document_artifact_id)
  where document_artifact_id is not null;
create index storage_archive_records_import_batch_idx
  on public.storage_archive_records (import_batch_id)
  where import_batch_id is not null;

create or replace function private.reject_append_only_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = '55000';
end;
$$;

create trigger audit_events_append_only
before update or delete on public.audit_events
for each row execute function private.reject_append_only_mutation();
create trigger storage_archive_records_append_only
before update or delete on public.storage_archive_records
for each row execute function private.reject_append_only_mutation();
create trigger storage_object_lifecycle_events_append_only
before update or delete on public.storage_object_lifecycle_events
for each row execute function private.reject_append_only_mutation();

create or replace function private.append_audit_event(
  p_actor_account_id uuid,
  p_action text,
  p_entity_table text,
  p_entity_id uuid,
  p_before_data jsonb,
  p_after_data jsonb,
  p_reason text default null,
  p_request_id uuid default null,
  p_correlation_id text default null,
  p_client_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  event_id uuid;
begin
  if p_actor_account_id is null
     or not exists (select 1 from public.app_accounts a where a.id = p_actor_account_id) then
    raise exception 'Known audit actor is required' using errcode = '23514';
  end if;
  if btrim(coalesce(p_action, '')) = '' or btrim(coalesce(p_entity_table, '')) = '' then
    raise exception 'Audit action and entity table are required' using errcode = '22023';
  end if;
  if p_client_metadata is null or jsonb_typeof(p_client_metadata) <> 'object' then
    raise exception 'Audit client metadata must be an object' using errcode = '22023';
  end if;
  insert into public.audit_events (
    actor_account_id, action, entity_table, entity_id, before_data, after_data,
    reason, request_id, correlation_id, client_metadata
  ) values (
    p_actor_account_id, p_action, p_entity_table, p_entity_id, p_before_data, p_after_data,
    p_reason, p_request_id, p_correlation_id, p_client_metadata
  ) returning id into event_id;
  return event_id;
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
    actor_id := coalesce(new.actor_account_id, private.current_account_id());
  elsif tg_op = 'DELETE' then
    actor_id := coalesce(old.actor_account_id, private.current_account_id());
  else
    actor_id := coalesce(new.actor_account_id, old.actor_account_id, private.current_account_id());
  end if;
  if actor_id is not null then
    if tg_op = 'INSERT' then
      perform private.append_audit_event(
        actor_id, 'COMMAND_CREATED', 'operation_commands', new.id, null, to_jsonb(new), null,
        new.id, null, jsonb_build_object('operation_code', new.operation_code)
      );
    elsif tg_op = 'DELETE' then
      perform private.append_audit_event(
        actor_id, 'COMMAND_DELETED', 'operation_commands', old.id, to_jsonb(old), null, null,
        old.id, null, jsonb_build_object('operation_code', old.operation_code)
      );
    else
      perform private.append_audit_event(
        actor_id, 'COMMAND_STATUS_CHANGED', 'operation_commands', new.id, to_jsonb(old), to_jsonb(new), null,
        new.id, null, jsonb_build_object('operation_code', new.operation_code)
      );
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger operation_commands_audit_event
after insert or update of status, result_entity_type, result_entity_id,
  last_error_code on public.operation_commands
for each row execute function private.audit_operation_command_change();

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
  actor_id := private.current_account_id();
  if actor_id is null then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
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
    '{}'::jsonb
  );
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

-- These are the business writes whose status, posting, approval, import and
-- download changes must be queryable without mutating the source row history.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'hr_requests', 'inventory_postings', 'warehouse_shipments',
    'replenishment_requests', 'stocktakes', 'return_notes',
    'seasonal_campaigns', 'seasonal_approval_reviews',
    'purchase_orders', 'purchase_receipts', 'erp_export_batches',
    'erp_export_artifacts', 'erp_export_download_events',
    'document_artifacts', 'master_import_batches', 'master_import_events',
    'master_export_batches', 'master_export_events'
  ] loop
    execute format('drop trigger if exists %I on public.%I', 'audit_' || table_name, table_name);
    execute format(
      'create trigger %I after insert or update or delete on public.%I for each row execute function private.audit_business_row_change()',
      'audit_' || table_name, table_name
    );
  end loop;
end;
$$;

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
  p_actor_account_id uuid,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.storage_archive_records
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  archive_row public.storage_archive_records;
  artifact_key text;
  artifact_hash text;
  artifact_status text;
begin
  current_account := private.current_account_id();
  if session_user <> 'job_storage_cleanup' then
    raise exception using errcode = '42501', message = 'job_storage_cleanup role is required';
  end if;
  current_account := p_actor_account_id;
  if current_account is null or not exists (select 1 from public.app_accounts where id = current_account) then
    raise exception 'Known archive actor is required' using errcode = '23514';
  end if;
  if p_source_kind not in ('ERP_ARTIFACT', 'DOCUMENT_ARTIFACT', 'IMPORT_BATCH') then
    raise exception 'Unsupported archive source kind' using errcode = '22023';
  end if;
  if btrim(coalesce(p_original_storage_object_key, '')) = ''
     or btrim(coalesce(p_archive_record_key, '')) = ''
     or btrim(coalesce(p_archive_object_key, '')) = ''
     or p_source_sha256 is null or p_source_sha256 !~ '^[0-9a-fA-F]{64}$'
     or p_archive_payload_sha256 is null or p_archive_payload_sha256 !~ '^[0-9a-fA-F]{64}$'
     or p_manifest_sha256 is null or p_manifest_sha256 !~ '^[0-9a-fA-F]{64}$'
     or p_verified_at is null or p_verified_at > now() then
    raise exception 'Archive object metadata and verification are required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or btrim(p_idempotency_key) = ''
     or p_request_fingerprint is null or btrim(p_request_fingerprint) = '' then
    raise exception 'Idempotency key and request fingerprint are required' using errcode = '22023';
  end if;

  insert into public.operation_commands (
    operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id
  ) values (
    'FINALIZE_STORAGE_ARCHIVE', p_idempotency_key, p_request_fingerprint, current_account
  ) on conflict (operation_code, idempotency_key) do nothing;
  select * into command_row
  from public.operation_commands
  where operation_code = 'FINALIZE_STORAGE_ARCHIVE'
    and idempotency_key = p_idempotency_key
  for update;
  if command_row.actor_account_id <> current_account
     or command_row.canonical_request_fingerprint <> p_request_fingerprint then
    raise exception 'Idempotency key is bound to a different request' using errcode = 'P0001';
  end if;
  if command_row.status = 'SUCCEEDED' then
    select * into archive_row from public.storage_archive_records where id = command_row.result_entity_id;
    return archive_row;
  end if;
  if command_row.status <> 'IN_PROGRESS' then
    raise exception 'Archive command is not retryable' using errcode = '55000';
  end if;

  if p_source_kind = 'ERP_ARTIFACT' then
    select storage_object_key, payload_sha256, status into artifact_key, artifact_hash, artifact_status
    from public.erp_export_artifacts where id = p_source_id for update;
    if not found or artifact_status is distinct from 'READY'
       or artifact_key is null or artifact_hash is null
       or artifact_key <> p_original_storage_object_key or artifact_hash <> p_source_sha256 then
      raise exception 'ERP artifact is not a matching READY source' using errcode = 'P0001';
    end if;
    insert into public.storage_archive_records (
      archive_record_key, erp_artifact_id, original_storage_object_key, source_sha256,
      archive_object_key, archive_payload_sha256, manifest_sha256, verified_at, finalized_by
    ) values (
      p_archive_record_key, p_source_id, p_original_storage_object_key, p_source_sha256,
      p_archive_object_key, p_archive_payload_sha256, p_manifest_sha256, p_verified_at, current_account
    ) returning * into archive_row;
  elsif p_source_kind = 'DOCUMENT_ARTIFACT' then
    select storage_object_key, payload_sha256, status into artifact_key, artifact_hash, artifact_status
    from public.document_artifacts where id = p_source_id for update;
    if not found or artifact_status is distinct from 'READY'
       or artifact_key is null or artifact_hash is null
       or artifact_key <> p_original_storage_object_key or artifact_hash <> p_source_sha256 then
      raise exception 'Document artifact is not a matching READY source' using errcode = 'P0001';
    end if;
    insert into public.storage_archive_records (
      archive_record_key, document_artifact_id, original_storage_object_key, source_sha256,
      archive_object_key, archive_payload_sha256, manifest_sha256, verified_at, finalized_by
    ) values (
      p_archive_record_key, p_source_id, p_original_storage_object_key, p_source_sha256,
      p_archive_object_key, p_archive_payload_sha256, p_manifest_sha256, p_verified_at, current_account
    ) returning * into archive_row;
  else
    select storage_object_key, file_sha256, status into artifact_key, artifact_hash, artifact_status
    from public.master_import_batches where id = p_source_id for update;
    if not found or artifact_status is distinct from 'APPLIED'
       or artifact_key is null or artifact_hash is null
       or artifact_key <> p_original_storage_object_key or artifact_hash <> p_source_sha256 then
      raise exception 'Applied import batch is not a matching source' using errcode = 'P0001';
    end if;
    insert into public.storage_archive_records (
      archive_record_key, import_batch_id, original_storage_object_key, source_sha256,
      archive_object_key, archive_payload_sha256, manifest_sha256, verified_at, finalized_by
    ) values (
      p_archive_record_key, p_source_id, p_original_storage_object_key, p_source_sha256,
      p_archive_object_key, p_archive_payload_sha256, p_manifest_sha256, p_verified_at, current_account
    ) returning * into archive_row;
  end if;
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'storage_archive_records',
      result_entity_id = archive_row.id, succeeded_at = now()
  where id = command_row.id;
  return archive_row;
end;
$$;

create or replace function public.record_storage_lifecycle_event(
  p_archive_record_id uuid,
  p_event_kind text,
  p_details jsonb,
  p_actor_account_id uuid,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.storage_object_lifecycle_events
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  event_row public.storage_object_lifecycle_events;
begin
  current_account := private.current_account_id();
  if session_user <> 'job_storage_cleanup' then
    raise exception using errcode = '42501', message = 'job_storage_cleanup role is required';
  end if;
  current_account := p_actor_account_id;
  if current_account is null or not exists (select 1 from public.app_accounts where id = current_account) then
    raise exception 'Known lifecycle actor is required' using errcode = '23514';
  end if;
  if p_event_kind not in ('PRODUCTION_REMOVED', 'RESTORED')
     or p_details is null or jsonb_typeof(p_details) <> 'object' then
    raise exception 'Lifecycle event details are invalid' using errcode = '22023';
  end if;
  insert into public.operation_commands (
    operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id
  ) values (
    'RECORD_STORAGE_LIFECYCLE', p_idempotency_key, p_request_fingerprint, current_account
  ) on conflict (operation_code, idempotency_key) do nothing;
  select * into command_row from public.operation_commands
  where operation_code = 'RECORD_STORAGE_LIFECYCLE' and idempotency_key = p_idempotency_key for update;
  if command_row.actor_account_id <> current_account
     or command_row.canonical_request_fingerprint <> p_request_fingerprint then
    raise exception 'Idempotency key is bound to a different request' using errcode = 'P0001';
  end if;
  if command_row.status = 'SUCCEEDED' then
    select * into event_row from public.storage_object_lifecycle_events where id = command_row.result_entity_id;
    return event_row;
  end if;
  if command_row.status <> 'IN_PROGRESS' then
    raise exception 'Lifecycle command is not retryable' using errcode = '55000';
  end if;
  perform 1 from public.storage_archive_records where id = p_archive_record_id for update;
  if not found then
    raise exception 'Finalized archive record is required' using errcode = '23503';
  end if;
  if p_event_kind = 'PRODUCTION_REMOVED' then
    if exists (
      select 1 from public.storage_object_lifecycle_events
      where archive_record_id = p_archive_record_id and event_kind = 'PRODUCTION_REMOVED'
        and not exists (
          select 1 from public.storage_object_lifecycle_events restored
          where restored.archive_record_id = storage_object_lifecycle_events.archive_record_id
            and restored.event_kind = 'RESTORED' and restored.event_at > storage_object_lifecycle_events.event_at
        )
    ) then
      raise exception 'Production object is already removed' using errcode = '55000';
    end if;
  elsif not exists (
    select 1 from public.storage_object_lifecycle_events
    where archive_record_id = p_archive_record_id and event_kind = 'PRODUCTION_REMOVED'
      and not exists (
        select 1 from public.storage_object_lifecycle_events restored
        where restored.archive_record_id = storage_object_lifecycle_events.archive_record_id
          and restored.event_kind = 'RESTORED' and restored.event_at > storage_object_lifecycle_events.event_at
      )
  ) then
    raise exception 'Production object is not currently removed' using errcode = '55000';
  end if;
  insert into public.storage_object_lifecycle_events (archive_record_id, event_kind, event_by, details)
  values (p_archive_record_id, p_event_kind, current_account, p_details)
  returning * into event_row;
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'storage_object_lifecycle_events',
      result_entity_id = event_row.id, succeeded_at = now()
  where id = command_row.id;
  return event_row;
end;
$$;

alter table public.audit_events enable row level security;
alter table public.storage_archive_records enable row level security;
alter table public.storage_object_lifecycle_events enable row level security;
create policy audit_events_read on public.audit_events
  for select to authenticated using (
    private.has_role('SYSTEM_ADMIN') or private.has_role('HR') or private.has_role('CEO')
  );
create policy storage_archive_records_read on public.storage_archive_records
  for select to authenticated using (private.has_role('SYSTEM_ADMIN') or private.has_role('CEO'));
create policy storage_object_lifecycle_events_read on public.storage_object_lifecycle_events
  for select to authenticated using (private.has_role('SYSTEM_ADMIN') or private.has_role('CEO'));

revoke all on table public.audit_events, public.storage_archive_records,
  public.storage_object_lifecycle_events from public, anon, authenticated;
revoke truncate on public.audit_events, public.storage_archive_records,
  public.storage_object_lifecycle_events from public, anon, authenticated;
grant select on public.audit_events, public.storage_archive_records,
  public.storage_object_lifecycle_events to authenticated;
revoke all on function private.append_audit_event(uuid, text, text, uuid, jsonb, jsonb, text, uuid, text, jsonb) from public, anon, authenticated;
-- These two functions are intentionally not exposed to authenticated users.
-- After provisioning the job-specific `job_storage_cleanup` role, grant
-- EXECUTE only to that role and keep the worker's Storage Admin credential out
-- of the browser. Until then, archive/lifecycle writes fail closed.
revoke all on function public.finalize_storage_archive(text, uuid, text, text, text, text, text, text, timestamptz, uuid, text, text) from public, anon, authenticated;
revoke all on function public.record_storage_lifecycle_event(uuid, text, jsonb, uuid, text, text) from public, anon, authenticated;
do $$
begin
  execute 'grant execute on function public.finalize_storage_archive(text, uuid, text, text, text, text, text, text, timestamptz, uuid, text, text) to job_storage_cleanup';
  execute 'grant execute on function public.record_storage_lifecycle_event(uuid, text, jsonb, uuid, text, text) to job_storage_cleanup';
end;
$$;
