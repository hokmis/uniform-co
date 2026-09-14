-- Forward-only renderer hardening.
-- This migration closes the two remaining escape hatches in 0039/0040:
-- renderer DB roles cannot write storage.objects directly, and every lease
-- generation receives a distinct object key.  Downloads are granted by the
-- audited RPCs for a short period instead of by a bucket-wide read policy.

revoke all on table storage.objects from job_document_renderer, job_erp_renderer;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'job_renderer_storage_proxy') then
    execute 'create role job_renderer_storage_proxy noinherit nologin';
  else
    execute 'alter role job_renderer_storage_proxy nologin noinherit';
  end if;
end;
$$;

create or replace function private.renderer_storage_capability(
  p_bucket_id text,
  p_object_key text,
  p_attempt_id uuid,
  p_lease_token text,
  p_lease_generation bigint
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  if session_user <> 'job_renderer_storage_proxy'
     or p_object_key is null or p_object_key like '%..%' or left(p_object_key, 1) = '/' then
    return false;
  end if;
  if p_bucket_id = 'uniform-pdf' then
    return exists (
      select 1
      from public.document_render_attempts r
      join public.document_artifacts a on a.id = r.artifact_id
      join public.document_artifact_families f on f.id = a.family_id
      where r.id = p_attempt_id and r.status = 'RENDERING'
        and r.lease_token = p_lease_token and r.lease_generation = p_lease_generation
        and r.lease_expires_at > transaction_timestamp() and r.temp_object_key = p_object_key
        and a.status = 'PREPARING' and f.active_artifact_id = a.id
    );
  elsif p_bucket_id = 'uniform-erp' then
    return exists (
      select 1
      from public.erp_export_render_attempts r
      join public.erp_export_artifacts a on a.id = r.artifact_id
      join public.erp_export_batches b on b.id = a.batch_id
      where r.id = p_attempt_id and r.status = 'RENDERING'
        and r.lease_token = p_lease_token and r.lease_generation = p_lease_generation
        and r.lease_expires_at > transaction_timestamp() and r.temp_object_key = p_object_key
        and a.status = 'PREPARING' and b.active_artifact_id = a.id
    );
  end if;
  return false;
end;
$$;
revoke all on function private.renderer_storage_capability(text,text,uuid,text,bigint) from public, anon, authenticated;
grant usage on schema private to job_renderer_storage_proxy;
grant execute on function private.renderer_storage_capability(text,text,uuid,text,bigint) to job_renderer_storage_proxy;

create or replace function private.require_document_renderer()
returns uuid language plpgsql security definer set search_path = pg_catalog, private as $$
declare a uuid;
begin
  if session_user <> 'job_document_renderer' then raise exception using errcode = '42501', message = 'job_document_renderer role is required'; end if;
  a := private.execution_actor_id();
  if a is null then raise exception using errcode = '42501', message = 'bound document renderer actor is required'; end if;
  return a;
end; $$;
create or replace function private.require_erp_renderer()
returns uuid language plpgsql security definer set search_path = pg_catalog, private as $$
declare a uuid;
begin
  if session_user <> 'job_erp_renderer' then raise exception using errcode = '42501', message = 'job_erp_renderer role is required'; end if;
  a := private.execution_actor_id();
  if a is null then raise exception using errcode = '42501', message = 'bound ERP renderer actor is required'; end if;
  return a;
end; $$;
revoke all on function private.require_document_renderer(), private.require_erp_renderer() from public, anon, authenticated;

create or replace function private.assign_renderer_generation_object_key()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  if new.status = 'RENDERING' and tg_op = 'INSERT' then
    new.temp_object_key := case tg_table_name
      when 'document_render_attempts' then 'pdf/' || new.id::text || '/' || new.lease_generation::text
      when 'erp_export_render_attempts' then 'erp/' || new.id::text || '/' || new.lease_generation::text
      else new.temp_object_key
    end;
  elsif new.status = 'RENDERING' and old.lease_generation is distinct from new.lease_generation then
    new.temp_object_key := case tg_table_name
      when 'document_render_attempts' then 'pdf/' || new.id::text || '/' || new.lease_generation::text
      when 'erp_export_render_attempts' then 'erp/' || new.id::text || '/' || new.lease_generation::text
      else new.temp_object_key
    end;
  end if;
  return new;
end;
$$;
drop trigger if exists renderer_generation_object_key on public.document_render_attempts;
create trigger renderer_generation_object_key
before insert or update on public.document_render_attempts
for each row execute function private.assign_renderer_generation_object_key();
drop trigger if exists erp_renderer_generation_object_key on public.erp_export_render_attempts;
create trigger erp_renderer_generation_object_key
before insert or update on public.erp_export_render_attempts
for each row execute function private.assign_renderer_generation_object_key();

-- Failed and superseded logical revisions remain evidence.  Only object-byte
-- cleanup is allowed later; no renderer artifact or attempt row is deletable.
create or replace function private.prevent_ready_document_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  if tg_table_name = 'document_artifact_families' then
    if tg_op = 'DELETE' then raise exception 'Document family is immutable'; end if;
    if old.document_type is distinct from new.document_type
       or old.document_id is distinct from new.document_id
       or old.artifact_kind is distinct from new.artifact_kind then
      raise exception 'Document family identity is immutable';
    end if;
    if old.artifact_kind <> 'DRAFT_WATERMARK'
       and (old.source_snapshot_version is distinct from new.source_snapshot_version
            or old.source_snapshot_hash is distinct from new.source_snapshot_hash) then
      raise exception 'Formal document family snapshot is immutable';
    end if;
  elsif tg_table_name = 'document_artifacts' then
    if tg_op = 'DELETE' then raise exception 'Document artifact history is immutable'; end if;
    if old.status = 'READY' then
      if old.id is distinct from new.id
         or old.family_id is distinct from new.family_id
         or old.revision is distinct from new.revision
         or old.idempotency_key is distinct from new.idempotency_key
         or old.request_fingerprint is distinct from new.request_fingerprint
         or old.supersedes_artifact_id is distinct from new.supersedes_artifact_id
         or old.template_version is distinct from new.template_version
         or old.source_snapshot_version is distinct from new.source_snapshot_version
         or old.source_snapshot_hash is distinct from new.source_snapshot_hash
         or old.storage_object_key is distinct from new.storage_object_key
         or old.payload_sha256 is distinct from new.payload_sha256
         or old.payload_size_bytes is distinct from new.payload_size_bytes
         or old.winning_attempt_id is distinct from new.winning_attempt_id
         or old.ready_at is distinct from new.ready_at
         or old.failed_at is distinct from new.failed_at
         or old.error_code is distinct from new.error_code
         or old.error_message is distinct from new.error_message
         or old.max_attempts is distinct from new.max_attempts
         or new.status <> 'READY'
         or (new.is_current and not old.is_current) then
        raise exception 'READY document payload is immutable';
      end if;
    end if;
  elsif tg_table_name = 'document_render_attempts' then
    if tg_op = 'DELETE' then raise exception 'Document render attempt history is immutable'; end if;
    if exists (select 1 from public.document_artifacts a where a.id = old.artifact_id and a.status = 'READY') then
      raise exception 'Attempts for READY document artifacts are immutable';
    end if;
  end if;
  return new;
end;
$$;

create or replace function private.prevent_erp_export_snapshot_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  if tg_table_name = 'erp_export_batches' then
    if tg_op = 'DELETE' then raise exception 'ERP batch snapshot is immutable'; end if;
    if old.batch_no is distinct from new.batch_no
       or old.export_kind is distinct from new.export_kind
       or old.distribution_date is distinct from new.distribution_date
       or old.institution_id_snapshot is distinct from new.institution_id_snapshot
       or old.institution_code_snapshot is distinct from new.institution_code_snapshot
       or old.institution_name_snapshot is distinct from new.institution_name_snapshot
       or old.source_snapshot_version is distinct from new.source_snapshot_version
       or old.source_snapshot_hash is distinct from new.source_snapshot_hash
       or old.prepared_at is distinct from new.prepared_at
       or old.prepared_by is distinct from new.prepared_by then
      raise exception 'ERP batch snapshot is immutable';
    end if;
  elsif tg_table_name = 'erp_export_artifacts' then
    if tg_op = 'DELETE' then raise exception 'ERP artifact history is immutable'; end if;
    if old.status = 'READY' then
      if old.id is distinct from new.id
         or old.batch_id is distinct from new.batch_id
         or old.revision is distinct from new.revision
         or old.idempotency_key is distinct from new.idempotency_key
         or old.request_fingerprint is distinct from new.request_fingerprint
         or old.supersedes_artifact_id is distinct from new.supersedes_artifact_id
         or old.format_version is distinct from new.format_version
         or old.source_snapshot_version is distinct from new.source_snapshot_version
         or old.source_snapshot_hash is distinct from new.source_snapshot_hash
         or old.storage_object_key is distinct from new.storage_object_key
         or old.payload_sha256 is distinct from new.payload_sha256
         or old.payload_size_bytes is distinct from new.payload_size_bytes
         or old.winning_attempt_id is distinct from new.winning_attempt_id
         or old.ready_at is distinct from new.ready_at
         or old.failed_at is distinct from new.failed_at
         or old.error_code is distinct from new.error_code
         or old.error_message is distinct from new.error_message
         or old.max_attempts is distinct from new.max_attempts
         or new.status <> 'READY'
         or (new.is_current and not old.is_current) then
        raise exception 'READY ERP payload is immutable';
      end if;
    end if;
  elsif tg_table_name = 'erp_export_render_attempts' then
    if tg_op = 'DELETE' then raise exception 'ERP render attempt history is immutable'; end if;
    if exists (select 1 from public.erp_export_artifacts a where a.id = old.artifact_id and a.status = 'READY') then
      raise exception 'Attempts for READY ERP artifacts are immutable';
    end if;
  end if;
  return new;
end;
$$;

create table if not exists public.document_download_grants (
  id uuid primary key default gen_random_uuid(),
  artifact_id uuid not null references public.document_artifacts(id) on delete restrict,
  account_id uuid not null references public.app_accounts(id) on delete restrict,
  object_key text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create table if not exists public.erp_download_grants (
  id uuid primary key default gen_random_uuid(),
  artifact_id uuid not null references public.erp_export_artifacts(id) on delete restrict,
  batch_id uuid not null references public.erp_export_batches(id) on delete restrict,
  account_id uuid not null references public.app_accounts(id) on delete restrict,
  object_key text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table public.document_download_grants enable row level security;
alter table public.document_download_grants force row level security;
alter table public.erp_download_grants enable row level security;
alter table public.erp_download_grants force row level security;
revoke all on table public.document_download_grants, public.erp_download_grants from public, anon, authenticated;
grant select on table public.document_download_grants, public.erp_download_grants to authenticated;
drop policy if exists document_download_grants_read on public.document_download_grants;
create policy document_download_grants_read on public.document_download_grants
for select to authenticated using (account_id = private.current_account_id() and expires_at > transaction_timestamp());
drop policy if exists erp_download_grants_read on public.erp_download_grants;
create policy erp_download_grants_read on public.erp_download_grants
for select to authenticated using (account_id = private.current_account_id() and expires_at > transaction_timestamp());

drop policy if exists uniform_pdf_ready_read on storage.objects;
create policy uniform_pdf_ready_read on storage.objects
for select to authenticated using (
  bucket_id = 'uniform-pdf' and exists (
    select 1 from public.document_download_grants g
    join public.document_artifacts a on a.id = g.artifact_id
    join public.document_artifact_families f on f.id = a.family_id
    where g.account_id = private.current_account_id()
      and g.object_key = storage.objects.name
      and g.expires_at > transaction_timestamp()
      and a.status = 'READY'
      and a.storage_object_key = storage.objects.name
      and ((f.document_type = 'HR_REQUEST' and private.has_role('HR'))
        or (f.document_type = 'STOCKTAKE' and (private.has_role('HR') or private.has_role('WAREHOUSE')))
        or (f.document_type = 'RETURN_NOTE' and private.has_role('HR')))
  )
);
drop policy if exists uniform_erp_ready_read on storage.objects;
create policy uniform_erp_ready_read on storage.objects
for select to authenticated using (
  bucket_id = 'uniform-erp' and exists (
    select 1 from public.erp_download_grants g
    join public.erp_export_artifacts a on a.id = g.artifact_id
    join public.erp_export_batches b on b.id = g.batch_id
    where g.account_id = private.current_account_id()
      and g.object_key = storage.objects.name
      and g.expires_at > transaction_timestamp()
      and a.status = 'READY'
      and a.batch_id = b.id
      and a.storage_object_key = storage.objects.name
      and (private.has_role('HR') or private.has_role('WAREHOUSE'))
  )
);

create or replace function public.download_document(p_artifact_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, private as $$
declare r public.document_artifacts; f public.document_artifact_families; aid uuid; grant_id uuid;
begin
  aid := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt()->>'role','') <> 'authenticated' or aid is null then raise exception using errcode='42501'; end if;
  select * into r from public.document_artifacts where id = p_artifact_id;
  select * into f from public.document_artifact_families where id = r.family_id;
  if r.id is null or r.status <> 'READY' then raise exception 'document is not downloadable' using errcode='55000'; end if;
  if not ((f.document_type = 'HR_REQUEST' and private.has_role('HR'))
       or (f.document_type = 'STOCKTAKE' and (private.has_role('HR') or private.has_role('WAREHOUSE')))
       or (f.document_type = 'RETURN_NOTE' and private.has_role('HR'))) then raise exception using errcode='42501'; end if;
  insert into public.document_download_grants(artifact_id, account_id, object_key, expires_at)
  values (r.id, aid, r.storage_object_key, transaction_timestamp() + interval '2 minutes') returning id into grant_id;
  perform private.append_audit_event(aid, 'DOCUMENT_DOWNLOAD_REQUESTED', 'document_artifacts', r.id, null, to_jsonb(r), null, null, null, jsonb_build_object('bucket','uniform-pdf','grant_id',grant_id));
  return jsonb_build_object('bucket','uniform-pdf','object_key',r.storage_object_key,'sha256',r.payload_sha256,'size_bytes',r.payload_size_bytes,'revision',r.revision,'grant_id',grant_id);
end;
$$;

create or replace function public.download_erp_artifact(p_batch_id uuid, p_artifact_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, private as $$
declare b public.erp_export_batches; r public.erp_export_artifacts; aid uuid; grant_id uuid;
begin
  aid := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt()->>'role','') <> 'authenticated' or aid is null or not (private.has_role('HR') or private.has_role('WAREHOUSE')) then raise exception using errcode='42501'; end if;
  select * into b from public.erp_export_batches where id = p_batch_id for update;
  select * into r from public.erp_export_artifacts where id = p_artifact_id and batch_id = p_batch_id;
  if b.id is null or r.id is null or r.status <> 'READY' or b.status not in ('GENERATED','DOWNLOADED','IMPORT_FAILED','IMPORT_CONFIRMED') then raise exception 'ERP artifact is not downloadable' using errcode='55000'; end if;
  insert into public.erp_download_grants(artifact_id, batch_id, account_id, object_key, expires_at)
  values (r.id, b.id, aid, r.storage_object_key, transaction_timestamp() + interval '2 minutes') returning id into grant_id;
  insert into public.erp_export_download_events(batch_id, artifact_id, downloaded_by) values (b.id, r.id, aid);
  update public.erp_export_batches set status = case when status = 'GENERATED' then 'DOWNLOADED' else status end, downloaded_at = coalesce(downloaded_at, now()) where id = b.id;
  return jsonb_build_object('bucket','uniform-erp','object_key',r.storage_object_key,'sha256',r.payload_sha256,'size_bytes',r.payload_size_bytes,'revision',r.revision,'batch_id',b.id,'grant_id',grant_id);
end;
$$;
revoke all on function public.download_document(uuid), public.download_erp_artifact(uuid,uuid) from public, anon;
grant execute on function public.download_document(uuid), public.download_erp_artifact(uuid,uuid) to authenticated;

-- Storage-js stores custom upload metadata under user_metadata on current
-- Supabase versions; older deployments exposed it under metadata.  Read both
-- forms so the worker/browser upload contract remains forward-compatible.
create or replace function public.confirm_import_upload(
  p_batch_id uuid,
  p_actual_mime_type text,
  p_actual_size_bytes bigint,
  p_file_sha256 text,
  p_row_count integer,
  p_actor_account_id uuid,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.import_batches
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  command_row public.operation_commands;
  batch_row public.import_batches;
  chunk_row public.import_batch_chunks;
  canonical_fingerprint text;
  object_mime text;
  object_size bigint;
  object_hash text;
  execution_actor uuid;
begin
  if session_user <> 'job_import_worker' then raise exception using errcode = '42501', message = 'job_import_worker role is required'; end if;
  execution_actor := private.execution_actor_id();
  if p_actor_account_id is null or execution_actor is distinct from p_actor_account_id
     or p_actual_size_bytes is null or p_actual_size_bytes < 1 or p_actual_size_bytes > 10000000
     or p_row_count is null or p_row_count < 1 or p_row_count > 10000
     or p_file_sha256 is null or p_file_sha256 !~ '^[0-9a-fA-F]{64}$'
     or btrim(coalesce(p_actual_mime_type, '')) = ''
     or btrim(coalesce(p_idempotency_key, '')) = '' or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'Verified upload metadata is invalid' using errcode = '22023';
  end if;
  canonical_fingerprint := encode(digest(jsonb_build_object('batch_id', p_batch_id, 'mime', p_actual_mime_type,
    'size', p_actual_size_bytes, 'sha256', lower(p_file_sha256), 'rows', p_row_count)::text, 'sha256'), 'hex');
  if p_request_fingerprint <> canonical_fingerprint then raise exception using errcode = '40001', message = 'Request fingerprint does not match canonical confirmation payload'; end if;
  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('CONFIRM_IMPORT_UPLOAD', p_idempotency_key, canonical_fingerprint, p_actor_account_id)
  on conflict (operation_code, idempotency_key) do nothing;
  select * into command_row from public.operation_commands where operation_code = 'CONFIRM_IMPORT_UPLOAD' and idempotency_key = p_idempotency_key for update;
  if command_row.actor_account_id <> p_actor_account_id or command_row.canonical_request_fingerprint <> canonical_fingerprint then raise exception using errcode = '40001', message = 'Idempotency key conflicts with another request'; end if;
  if command_row.status = 'SUCCEEDED' then select * into batch_row from public.import_batches where id = command_row.result_entity_id; return batch_row; end if;
  if command_row.status <> 'IN_PROGRESS' then raise exception using errcode = '55000', message = 'Import confirmation is not retryable'; end if;
  select * into batch_row from public.import_batches where id = p_batch_id for update;
  if not found or batch_row.status <> 'AWAITING_UPLOAD' or batch_row.upload_expires_at <= now()
     or p_actual_mime_type <> batch_row.expected_mime_type or p_actual_size_bytes <> batch_row.expected_size_bytes
     or batch_row.upload_started_by is distinct from p_actor_account_id then
    raise exception 'Upload is expired or metadata does not match the declared object' using errcode = 'P0001';
  end if;
  if batch_row.import_type = 'OPENING_BALANCE' then
    perform 1 from public.system_cutover_state where id = 1 and status = 'PRE_CUTOVER' for update;
    if not found then raise exception using errcode = '55000', message = 'Opening uploads require PRE_CUTOVER'; end if;
  end if;
  select coalesce(nullif(o.user_metadata ->> 'mimetype', ''), nullif(o.metadata ->> 'mimetype', ''), ''),
         coalesce(nullif(o.user_metadata ->> 'size', ''), nullif(o.metadata ->> 'size', ''), '')::bigint,
         lower(coalesce(nullif(o.user_metadata ->> 'sha256', ''), nullif(o.metadata ->> 'sha256', ''), ''))
    into object_mime, object_size, object_hash
    from storage.objects o
    where o.bucket_id = batch_row.storage_bucket and o.name = batch_row.storage_object_key
    for update;
  if not found or object_mime is distinct from batch_row.expected_mime_type or object_size is distinct from batch_row.expected_size_bytes or object_hash is distinct from lower(p_file_sha256) then
    raise exception 'Storage object is missing or verified metadata does not match' using errcode = 'P0001';
  end if;
  update public.import_batches set status = 'UPLOADED', file_sha256 = lower(p_file_sha256), uploaded_at = now(), uploaded_by = p_actor_account_id,
    row_count = p_row_count, valid_row_count = 0, error_row_count = 0 where id = batch_row.id;
  insert into public.import_batch_chunks (batch_id, phase, chunk_no, start_row_number, end_row_number, idempotency_key)
    values (batch_row.id, 'PARSE', 1, 1, p_row_count, 'PARSE-' || batch_row.id::text || '-1') on conflict (batch_id, phase, chunk_no) do nothing returning * into chunk_row;
  update public.operation_commands set status = 'SUCCEEDED', result_entity_type = 'import_batches', result_entity_id = batch_row.id, succeeded_at = now() where id = command_row.id;
  select * into batch_row from public.import_batches where id = batch_row.id;
  return batch_row;
end;
$$;
revoke all on function public.confirm_import_upload(uuid,text,bigint,text,integer,uuid,text,text) from public, anon, authenticated;
grant execute on function public.confirm_import_upload(uuid,text,bigint,text,integer,uuid,text,text) to job_import_worker;
