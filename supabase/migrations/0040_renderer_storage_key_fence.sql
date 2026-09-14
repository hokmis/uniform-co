-- Forward-only renderer hardening.
-- Renderer roles may touch only the object key reserved by their live lease;
-- a bucket-wide Storage policy would let a compromised adapter enumerate or
-- overwrite another attempt's object.

create or replace function private.renderer_storage_key_allowed(
  p_bucket_id text,
  p_object_key text
)
returns boolean
language sql
security definer
set search_path = pg_catalog, private
as $$
  select case
    when session_user = 'job_document_renderer' and p_bucket_id = 'uniform-pdf' then exists (
      select 1
      from public.document_render_attempts r
      join public.document_artifacts a on a.id = r.artifact_id
      join public.document_artifact_families f on f.id = a.family_id
      where r.status = 'RENDERING'
        and r.temp_object_key = p_object_key
        and r.lease_expires_at > transaction_timestamp()
        and a.status = 'PREPARING'
        and f.active_artifact_id = a.id
    )
    when session_user = 'job_erp_renderer' and p_bucket_id = 'uniform-erp' then exists (
      select 1
      from public.erp_export_render_attempts r
      join public.erp_export_artifacts a on a.id = r.artifact_id
      join public.erp_export_batches b on b.id = a.batch_id
      where r.status = 'RENDERING'
        and r.temp_object_key = p_object_key
        and r.lease_expires_at > transaction_timestamp()
        and a.status = 'PREPARING'
        and b.active_artifact_id = a.id
    )
    else false
  end;
$$;

revoke all on function private.renderer_storage_key_allowed(text, text) from public, anon, authenticated;
grant execute on function private.renderer_storage_key_allowed(text, text) to job_document_renderer, job_erp_renderer;

drop policy if exists uniform_pdf_renderer_select on storage.objects;
create policy uniform_pdf_renderer_select on storage.objects
for select to job_document_renderer
using (private.renderer_storage_key_allowed(bucket_id, name));

drop policy if exists uniform_pdf_renderer_insert on storage.objects;
create policy uniform_pdf_renderer_insert on storage.objects
for insert to job_document_renderer
with check (private.renderer_storage_key_allowed(bucket_id, name));

drop policy if exists uniform_erp_renderer_select on storage.objects;
create policy uniform_erp_renderer_select on storage.objects
for select to job_erp_renderer
using (private.renderer_storage_key_allowed(bucket_id, name));

drop policy if exists uniform_erp_renderer_insert on storage.objects;
create policy uniform_erp_renderer_insert on storage.objects
for insert to job_erp_renderer
with check (private.renderer_storage_key_allowed(bucket_id, name));

-- ERP batch snapshots are immutable just like PDF families.  The current
-- pointer/status transitions are performed only by the fenced finalize/fail
-- RPCs; direct DELETE must never remove a logical source snapshot.
create or replace function private.prevent_erp_export_snapshot_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  if tg_table_name = 'erp_export_batches' then
    if tg_op = 'DELETE' then
      raise exception 'ERP batch snapshot is immutable';
    end if;
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
    if old.status = 'READY' then
      if tg_op = 'DELETE' then
        raise exception 'READY ERP payload is immutable';
      end if;
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
  elsif tg_table_name = 'erp_export_render_attempts'
        and tg_op <> 'DELETE'
        and exists (
          select 1
          from public.erp_export_artifacts a
          where a.id = old.artifact_id and a.status = 'READY'
        ) then
    raise exception 'Attempts for READY ERP artifacts are immutable';
  elsif tg_table_name = 'erp_export_render_attempts' and tg_op = 'DELETE'
        and exists (
          select 1
          from public.erp_export_artifacts a
          where a.id = old.artifact_id and a.status = 'READY'
        ) then
    raise exception 'Attempts for READY ERP artifacts are immutable';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
