create or replace function public.fail_import_upload(
  p_batch_id uuid,
  p_error_code text,
  p_error_message text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.import_batches
language plpgsql security definer
set search_path = pg_catalog, private
as $$
declare
  actor_id uuid;
  command_row public.operation_commands;
  batch_row public.import_batches;
  canonical_fingerprint text;
begin
  actor_id := private.require_import_worker();
  if p_batch_id is null or btrim(coalesce(p_error_code, '')) = '' or btrim(coalesce(p_idempotency_key, '')) = '' then
    raise exception 'Import upload failure fields are invalid' using errcode = '22023';
  end if;
  canonical_fingerprint := encode(digest(jsonb_build_object('batch_id', p_batch_id, 'error_code', left(btrim(p_error_code), 100), 'error_message', left(btrim(coalesce(p_error_message, '')), 500))::text, 'sha256'), 'hex');
  if p_request_fingerprint is distinct from canonical_fingerprint then raise exception 'Import upload failure fingerprint mismatch' using errcode = '40001'; end if;
  insert into public.operation_commands(operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('FAIL_IMPORT_UPLOAD', p_idempotency_key, canonical_fingerprint, actor_id)
  on conflict (operation_code, idempotency_key) do nothing;
  select * into command_row from public.operation_commands where operation_code = 'FAIL_IMPORT_UPLOAD' and idempotency_key = p_idempotency_key for update;
  if command_row.actor_account_id is distinct from actor_id or command_row.canonical_request_fingerprint <> canonical_fingerprint then raise exception 'Import upload failure idempotency conflict' using errcode = '40001'; end if;
  if command_row.status = 'SUCCEEDED' then select * into batch_row from public.import_batches where id = command_row.result_entity_id; return batch_row; end if;
  if command_row.status <> 'IN_PROGRESS' then raise exception 'Import upload failure is not retryable' using errcode = '55000'; end if;
  select * into batch_row from public.import_batches where id = p_batch_id for update;
  if not found or batch_row.status <> 'AWAITING_UPLOAD' then raise exception 'Import upload is no longer awaiting confirmation' using errcode = '55000'; end if;
  update public.import_batches set status = 'FAILED', last_error_code = left(btrim(p_error_code), 100), last_error_message = left(btrim(coalesce(p_error_message, '')), 500) where id = p_batch_id returning * into batch_row;
  update public.operation_commands set status = 'SUCCEEDED', result_entity_type = 'import_batches', result_entity_id = batch_row.id, succeeded_at = now() where id = command_row.id;
  return batch_row;
end;
$$;
revoke all on function public.fail_import_upload(uuid,text,text,text,text) from public, anon, authenticated;
grant execute on function public.fail_import_upload(uuid,text,text,text,text) to job_import_worker;
