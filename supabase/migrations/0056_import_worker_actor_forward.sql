-- The worker authenticates as job_import_worker while p_actor_account_id
-- remains the human uploader recorded on the durable batch.
create or replace function public.confirm_import_upload(
  p_batch_id uuid, p_actual_mime_type text, p_actual_size_bytes bigint,
  p_file_sha256 text, p_row_count integer, p_actor_account_id uuid,
  p_idempotency_key text, p_request_fingerprint text
)
returns public.import_batches
language plpgsql security definer
set search_path = pg_catalog, private
as $$
declare
  execution_actor uuid;
  command_row public.operation_commands;
  batch_row public.import_batches;
  chunk_row public.import_batch_chunks;
  canonical_fingerprint text;
  object_mime text;
  object_size bigint;
  object_hash text;
begin
  if session_user <> 'job_import_worker' then raise exception using errcode = '42501', message = 'job_import_worker role is required'; end if;
  execution_actor := private.require_import_worker();
  if execution_actor is null or p_actor_account_id is null
     or p_actual_size_bytes is null or p_actual_size_bytes < 1 or p_actual_size_bytes > 10000000
     or p_row_count is null or p_row_count < 1 or p_row_count > 10000
     or p_file_sha256 is null or p_file_sha256 !~ '^[0-9a-fA-F]{64}$'
     or btrim(coalesce(p_actual_mime_type, '')) = ''
     or btrim(coalesce(p_idempotency_key, '')) = '' or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'Verified upload metadata is invalid' using errcode = '22023';
  end if;
  canonical_fingerprint := encode(digest(jsonb_build_object('batch_id', p_batch_id, 'mime', p_actual_mime_type, 'size', p_actual_size_bytes, 'sha256', lower(p_file_sha256), 'rows', p_row_count)::text, 'sha256'), 'hex');
  if p_request_fingerprint <> canonical_fingerprint then raise exception 'Request fingerprint does not match canonical confirmation payload' using errcode = '40001'; end if;
  insert into public.operation_commands(operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('CONFIRM_IMPORT_UPLOAD', p_idempotency_key, canonical_fingerprint, p_actor_account_id)
  on conflict (operation_code, idempotency_key) do nothing;
  select * into command_row from public.operation_commands where operation_code = 'CONFIRM_IMPORT_UPLOAD' and idempotency_key = p_idempotency_key for update;
  if command_row.actor_account_id is distinct from p_actor_account_id or command_row.canonical_request_fingerprint <> canonical_fingerprint then raise exception 'Idempotency key conflicts with another request' using errcode = '40001'; end if;
  if command_row.status = 'SUCCEEDED' then select * into batch_row from public.import_batches where id = command_row.result_entity_id; return batch_row; end if;
  if command_row.status <> 'IN_PROGRESS' then raise exception 'Import confirmation is not retryable' using errcode = '55000'; end if;
  select * into batch_row from public.import_batches where id = p_batch_id for update;
  if not found or batch_row.status <> 'AWAITING_UPLOAD' or batch_row.upload_expires_at <= now()
     or p_actual_mime_type <> batch_row.expected_mime_type or p_actual_size_bytes <> batch_row.expected_size_bytes
     or batch_row.upload_started_by is distinct from p_actor_account_id then
    raise exception 'Upload is expired or metadata does not match the declared object';
  end if;
  if batch_row.import_type = 'OPENING_BALANCE' then
    perform 1 from public.system_cutover_state where id = 1 and status = 'PRE_CUTOVER' for update;
    if not found then raise exception 'Opening uploads require PRE_CUTOVER'; end if;
  end if;
  select coalesce(nullif(o.user_metadata ->> 'mimetype', ''), nullif(o.metadata ->> 'mimetype', ''), ''),
         coalesce(nullif(o.user_metadata ->> 'size', ''), nullif(o.metadata ->> 'size', ''), '')::bigint,
         lower(coalesce(nullif(o.user_metadata ->> 'sha256', ''), nullif(o.metadata ->> 'sha256', ''), ''))
    into object_mime, object_size, object_hash
    from storage.objects o where o.bucket_id = batch_row.storage_bucket and o.name = batch_row.storage_object_key for update;
  if not found or object_mime is distinct from batch_row.expected_mime_type or object_size is distinct from batch_row.expected_size_bytes or object_hash is distinct from lower(p_file_sha256) then
    raise exception 'Storage object is missing or verified metadata does not match';
  end if;
  update public.import_batches set status = 'UPLOADED', file_sha256 = lower(p_file_sha256), uploaded_at = now(), uploaded_by = p_actor_account_id, row_count = p_row_count, valid_row_count = 0, error_row_count = 0 where id = batch_row.id;
  insert into public.import_batch_chunks(batch_id, phase, chunk_no, start_row_number, end_row_number, idempotency_key)
  values (batch_row.id, 'PARSE', 1, 1, p_row_count, 'PARSE-' || batch_row.id::text || '-1') on conflict (batch_id, phase, chunk_no) do nothing;
  update public.operation_commands set status = 'SUCCEEDED', result_entity_type = 'import_batches', result_entity_id = batch_row.id, succeeded_at = now() where id = command_row.id;
  select * into batch_row from public.import_batches where id = batch_row.id;
  return batch_row;
end;
$$;


revoke all on function public.confirm_import_upload(uuid,text,bigint,text,integer,uuid,text,text) from public, anon, authenticated;
grant execute on function public.confirm_import_upload(uuid,text,bigint,text,integer,uuid,text,text) to job_import_worker;
