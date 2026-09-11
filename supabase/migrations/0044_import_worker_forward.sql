-- Forward hardening for the durable import worker.
-- The parser contract lives in the protected worker process; this migration
-- makes the phase boundary explicit so only validated, confirmed batches can
-- acquire an APPLY lease, and keeps all worker state transitions auditable.

create or replace function public.claim_import_apply(
  p_batch_id uuid,
  p_lease_seconds integer,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.import_batches
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  actor_id uuid;
  command_row public.operation_commands;
  batch_row public.import_batches;
  canonical_fingerprint text;
begin
  actor_id := private.require_import_worker();
  if p_batch_id is null or p_lease_seconds is null or p_lease_seconds not between 60 and 1800
     or btrim(coalesce(p_idempotency_key, '')) = '' then
    raise exception 'Import apply claim fields are invalid' using errcode = '22023';
  end if;
  canonical_fingerprint := encode(digest(jsonb_build_object(
    'batch_id', p_batch_id, 'lease_seconds', p_lease_seconds
  )::text, 'sha256'), 'hex');
  if p_request_fingerprint is distinct from canonical_fingerprint then
    raise exception 'Import apply claim fingerprint mismatch' using errcode = '40001';
  end if;
  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('CLAIM_IMPORT_APPLY', p_idempotency_key, canonical_fingerprint, actor_id)
  on conflict (operation_code, idempotency_key) do nothing;
  select * into command_row from public.operation_commands
  where operation_code = 'CLAIM_IMPORT_APPLY' and idempotency_key = p_idempotency_key for update;
  if command_row.actor_account_id <> actor_id
     or command_row.canonical_request_fingerprint <> canonical_fingerprint then
    raise exception 'Import apply claim idempotency conflict' using errcode = '40001';
  end if;
  if command_row.status = 'SUCCEEDED' then
    select * into batch_row from public.import_batches where id = p_batch_id;
    return batch_row;
  end if;
  if command_row.status <> 'IN_PROGRESS' then
    raise exception 'Import apply claim is not retryable' using errcode = '55000';
  end if;
  select * into batch_row from public.import_batches where id = p_batch_id for update;
  if not found or batch_row.status not in ('VALIDATED', 'APPLYING')
     or (batch_row.status = 'APPLYING' and batch_row.lease_expires_at > transaction_timestamp()) then
    raise exception 'Import batch is not ready for APPLY lease' using errcode = '55000';
  end if;
  if batch_row.confirmed_at is null or batch_row.confirmed_by is null then
    raise exception 'Import batch requires user confirmation before APPLY' using errcode = '55000';
  end if;
  if batch_row.attempt_count >= batch_row.max_attempts then
    update public.import_batches
    set status = 'FAILED', last_error_code = 'MAX_ATTEMPTS_EXCEEDED',
        last_error_message = 'Import APPLY attempt limit exceeded', next_retry_at = null,
        lease_token = null, lease_owner = null, lease_expires_at = null
    where id = batch_row.id;
    update public.operation_commands
    set status = 'TERMINAL_FAILED', result_entity_type = 'import_batches',
        result_entity_id = batch_row.id, last_error_code = 'MAX_ATTEMPTS_EXCEEDED'
    where id = command_row.id;
    select * into batch_row from public.import_batches where id = p_batch_id;
    return batch_row;
  end if;
  if exists (
    select 1 from public.import_rows r
    where r.batch_id = batch_row.id
      and (r.proposed_action is null or r.proposed_action in ('ERROR'))
  ) then
    raise exception 'Import batch contains unresolved preview rows' using errcode = '55000';
  end if;
  if exists (
    select 1 from public.import_rows r
    where r.batch_id = batch_row.id and jsonb_array_length(r.validation_errors) > 0
  ) then
    raise exception 'Import batch contains validation errors' using errcode = '55000';
  end if;
  if exists (
    select 1 from public.import_field_diffs d
    join public.import_rows r on r.id = d.import_row_id
    where r.batch_id = batch_row.id and not d.confirmed
  ) then
    raise exception 'Import batch has unconfirmed field differences' using errcode = '55000';
  end if;
  update public.import_batches
  set status = 'APPLYING', lease_token = encode(gen_random_bytes(24), 'hex'),
      lease_generation = lease_generation + 1, lease_owner = session_user,
      lease_expires_at = transaction_timestamp() + make_interval(secs => p_lease_seconds),
      attempt_count = attempt_count + 1, next_retry_at = null, cursor_version = cursor_version + 1
  where id = p_batch_id returning * into batch_row;
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'import_batches', result_entity_id = batch_row.id, succeeded_at = now()
  where id = command_row.id;
  return batch_row;
end;
$$;

revoke all on function public.claim_import_apply(uuid, integer, text, text) from public, anon, authenticated;
grant execute on function public.claim_import_apply(uuid, integer, text, text) to job_import_worker;
