-- Forward compatibility for environments that already applied 0031/0032.
-- Do not edit the earlier migrations in place: Supabase will not replay them.

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'job_storage_cleanup') then
    execute 'alter role job_storage_cleanup nologin noinherit';
  else
    execute 'create role job_storage_cleanup noinherit nologin';
  end if;
  if exists (select 1 from pg_roles where rolname = 'job_import_worker') then
    execute 'alter role job_import_worker nologin noinherit';
  else
    execute 'create role job_import_worker noinherit nologin';
  end if;
end;
$$;

-- 0031 predates the durable import state machine and pointed IMPORT_BATCH
-- archives at the legacy master-import table. Keep that legacy FK for already
-- archived rows and add a separate FK for the durable import_batches table.
alter table public.storage_archive_records
  add column if not exists durable_import_batch_id uuid
    references public.import_batches(id);

do $$
declare
  constraint_name text;
begin
  select c.conname into constraint_name
  from pg_constraint c
  where c.conrelid = 'public.storage_archive_records'::regclass
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) like '%num_nonnulls%'
  limit 1;
  if constraint_name is not null then
    execute format('alter table public.storage_archive_records drop constraint %I', constraint_name);
  end if;
end;
$$;

alter table public.storage_archive_records
  add constraint storage_archive_records_one_source_v2
  check (num_nonnulls(
    erp_artifact_id,
    document_artifact_id,
    import_batch_id,
    durable_import_batch_id
  ) = 1);

create index if not exists storage_archive_records_durable_import_batch_idx
  on public.storage_archive_records (durable_import_batch_id)
  where durable_import_batch_id is not null;

-- The durable import tables were introduced after the original audit trigger
-- list. Add the same append-only business-row audit coverage to all stages.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'import_batches', 'import_batch_chunks', 'import_rows', 'import_field_diffs'
  ] loop
    execute format(
      'drop trigger if exists %I on public.%I',
      'audit_' || table_name, table_name
    );
    execute format(
      'create trigger %I after insert or update or delete on public.%I '
      'for each row execute function private.audit_business_row_change()',
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
    from public.import_batches where id = p_source_id for update;
    if not found or artifact_status is distinct from 'APPLIED'
       or artifact_key is null or artifact_hash is null
       or artifact_key <> p_original_storage_object_key or artifact_hash <> p_source_sha256 then
      raise exception 'Applied durable import batch is not a matching source' using errcode = 'P0001';
    end if;
    insert into public.storage_archive_records (
      archive_record_key, durable_import_batch_id, original_storage_object_key, source_sha256,
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

revoke all on function public.finalize_storage_archive(text, uuid, text, text, text, text, text, text, timestamptz, uuid, text, text) from public, anon, authenticated;
do $$
begin
  execute 'grant execute on function public.finalize_storage_archive(text, uuid, text, text, text, text, text, text, timestamptz, uuid, text, text) to job_storage_cleanup';
end;
$$;

