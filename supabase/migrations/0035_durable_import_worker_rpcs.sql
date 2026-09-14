-- Durable import worker state machine.
-- This migration deliberately keeps parsing outside Postgres: a trusted job
-- reads the verified private object, then writes only bounded, fenced chunks.

alter table public.import_batch_chunks
  drop constraint if exists import_batch_chunks_status_check;
alter table public.import_batch_chunks
  add constraint import_batch_chunks_status_check
  check (status in ('PENDING', 'PROCESSING', 'LEASED', 'RETRY_WAIT', 'COMPLETED', 'FAILED'));

alter table public.import_batches
  add column if not exists confirmed_at timestamptz,
  add column if not exists confirmed_by uuid references public.app_accounts(id);

create or replace function private.require_import_worker()
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  actor_id uuid;
begin
  if session_user <> 'job_import_worker' then
    raise exception using errcode = '42501', message = 'job_import_worker role is required';
  end if;
  actor_id := private.execution_actor_id();
  if actor_id is null then
    raise exception using errcode = '42501', message = 'A bound import worker actor is required';
  end if;
  return actor_id;
end;
$$;

revoke all on function private.require_import_worker() from public, anon, authenticated;

create or replace function public.claim_import_chunk(
  p_batch_id uuid,
  p_phase text,
  p_lease_seconds integer,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.import_batch_chunks
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  actor_id uuid;
  command_row public.operation_commands;
  batch_row public.import_batches;
  chunk_row public.import_batch_chunks;
  canonical_fingerprint text;
begin
  actor_id := private.require_import_worker();
  if p_batch_id is null
     or upper(btrim(coalesce(p_phase, ''))) not in ('PARSE', 'VALIDATE')
     or p_lease_seconds is null or p_lease_seconds not between 30 and 900
     or btrim(coalesce(p_idempotency_key, '')) = '' then
    raise exception 'Import chunk claim fields are invalid' using errcode = '22023';
  end if;
  p_phase := upper(btrim(p_phase));
  canonical_fingerprint := encode(digest(jsonb_build_object(
    'batch_id', p_batch_id, 'phase', p_phase, 'lease_seconds', p_lease_seconds
  )::text, 'sha256'), 'hex');
  if p_request_fingerprint is distinct from canonical_fingerprint then
    raise exception 'Import chunk claim fingerprint mismatch' using errcode = '40001';
  end if;

  insert into public.operation_commands (
    operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id
  ) values (
    'CLAIM_IMPORT_CHUNK', p_idempotency_key, canonical_fingerprint, actor_id
  ) on conflict (operation_code, idempotency_key) do nothing;
  select * into command_row from public.operation_commands
  where operation_code = 'CLAIM_IMPORT_CHUNK' and idempotency_key = p_idempotency_key
  for update;
  if command_row.actor_account_id <> actor_id
     or command_row.canonical_request_fingerprint <> canonical_fingerprint then
    raise exception 'Import chunk claim idempotency conflict' using errcode = '40001';
  end if;
  if command_row.status = 'SUCCEEDED' then
    if command_row.result_entity_id is null then return null; end if;
    select * into chunk_row from public.import_batch_chunks where id = command_row.result_entity_id;
    return chunk_row;
  end if;
  if command_row.status <> 'IN_PROGRESS' then
    raise exception 'Import chunk claim is not retryable' using errcode = '55000';
  end if;

  select * into batch_row from public.import_batches where id = p_batch_id for update;
  if not found or batch_row.status in ('APPLIED', 'CANCELLED', 'FAILED') then
    raise exception 'Import batch is not claimable' using errcode = '55000';
  end if;
  if p_phase = 'PARSE' and batch_row.status not in ('UPLOADED', 'PARSING') then
    raise exception 'Import batch is not ready for parsing' using errcode = '55000';
  end if;
  if p_phase = 'VALIDATE' and batch_row.status <> 'VALIDATING' then
    raise exception 'Import batch is not ready for validation' using errcode = '55000';
  end if;

  select * into chunk_row
  from public.import_batch_chunks
  where batch_id = p_batch_id
    and phase = p_phase
    and (
      status in ('PENDING', 'PROCESSING')
      or (status = 'RETRY_WAIT' and coalesce(next_retry_at, now()) <= now())
      or (status = 'LEASED' and lease_expires_at <= transaction_timestamp())
    )
  order by chunk_no
  for update skip locked
  limit 1;
  if not found then
    update public.operation_commands
    set status = 'SUCCEEDED', result_entity_type = null, result_entity_id = null, succeeded_at = now()
    where id = command_row.id;
    return null;
  end if;

  update public.import_batch_chunks
  set status = 'LEASED',
      lease_token = encode(gen_random_bytes(24), 'hex'),
      lease_generation = chunk_row.lease_generation + 1,
      lease_owner = session_user,
      lease_expires_at = transaction_timestamp() + make_interval(secs => p_lease_seconds),
      attempt_count = chunk_row.attempt_count + 1,
      next_retry_at = null,
      started_at = coalesce(started_at, now()),
      last_error_code = null,
      last_error_message = null
  where id = chunk_row.id
  returning * into chunk_row;
  update public.import_batches
  set status = case when p_phase = 'PARSE' then 'PARSING' else 'VALIDATING' end
  where id = p_batch_id
    and status in ('UPLOADED', 'PARSING', 'VALIDATING');
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'import_batch_chunks',
      result_entity_id = chunk_row.id, succeeded_at = now()
  where id = command_row.id;
  return chunk_row;
end;
$$;

create or replace function public.heartbeat_import_chunk(
  p_chunk_id uuid,
  p_lease_token text,
  p_lease_generation bigint,
  p_expected_cursor_version bigint,
  p_lease_seconds integer
)
returns public.import_batch_chunks
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  actor_id uuid;
  chunk_row public.import_batch_chunks;
begin
  actor_id := private.require_import_worker();
  if p_chunk_id is null or btrim(coalesce(p_lease_token, '')) = ''
     or p_lease_generation is null or p_expected_cursor_version is null
     or p_lease_seconds is null or p_lease_seconds not between 30 and 900 then
    raise exception 'Import heartbeat fields are invalid' using errcode = '22023';
  end if;
  update public.import_batch_chunks
  set lease_expires_at = transaction_timestamp() + make_interval(secs => p_lease_seconds),
      lease_owner = session_user,
      cursor_version = cursor_version + 1
  where id = p_chunk_id
    and status = 'LEASED'
    and lease_token = p_lease_token
    and lease_generation = p_lease_generation
    and lease_expires_at > transaction_timestamp()
    and cursor_version = p_expected_cursor_version
  returning * into chunk_row;
  if not found then
    raise exception 'Import chunk lease or cursor is stale' using errcode = '40001';
  end if;
  return chunk_row;
end;
$$;

create or replace function public.complete_import_chunk(
  p_chunk_id uuid,
  p_lease_token text,
  p_lease_generation bigint,
  p_expected_cursor_version bigint,
  p_rows jsonb,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.import_batch_chunks
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  actor_id uuid;
  command_row public.operation_commands;
  chunk_row public.import_batch_chunks;
  batch_row public.import_batches;
  row_value jsonb;
  diff_value jsonb;
  row_number_value integer;
  raw_values_value jsonb;
  normalized_values_value jsonb;
  validation_errors_value jsonb;
  proposed_action_value text;
  field_name_value text;
  seen_rows integer[] := '{}'::integer[];
  contiguous_cursor integer := 0;
  range_row record;
  canonical_fingerprint text;
begin
  actor_id := private.require_import_worker();
  if p_chunk_id is null or btrim(coalesce(p_lease_token, '')) = ''
     or p_lease_generation is null or p_expected_cursor_version is null
     or p_rows is null or jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) > 10000 or pg_column_size(p_rows) > 10000000
     or btrim(coalesce(p_idempotency_key, '')) = '' then
    raise exception 'Import chunk completion fields are invalid' using errcode = '22023';
  end if;
  canonical_fingerprint := encode(digest(jsonb_build_object(
    'chunk_id', p_chunk_id, 'lease_generation', p_lease_generation,
    'cursor_version', p_expected_cursor_version, 'rows', p_rows
  )::text, 'sha256'), 'hex');
  if p_request_fingerprint is distinct from canonical_fingerprint then
    raise exception 'Import chunk completion fingerprint mismatch' using errcode = '40001';
  end if;
  insert into public.operation_commands (
    operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id
  ) values (
    'COMPLETE_IMPORT_CHUNK', p_idempotency_key, canonical_fingerprint, actor_id
  ) on conflict (operation_code, idempotency_key) do nothing;
  select * into command_row from public.operation_commands
  where operation_code = 'COMPLETE_IMPORT_CHUNK' and idempotency_key = p_idempotency_key
  for update;
  if command_row.actor_account_id <> actor_id
     or command_row.canonical_request_fingerprint <> canonical_fingerprint then
    raise exception 'Import chunk completion idempotency conflict' using errcode = '40001';
  end if;
  if command_row.status = 'SUCCEEDED' then
    select * into chunk_row from public.import_batch_chunks where id = command_row.result_entity_id;
    return chunk_row;
  end if;
  if command_row.status <> 'IN_PROGRESS' then
    raise exception 'Import chunk completion is not retryable' using errcode = '55000';
  end if;

  -- Every worker transition uses batch -> chunk ordering.  Claim already
  -- follows this order; completion must do the same to avoid a claim/finish
  -- deadlock while the batch state is being advanced.
  select * into chunk_row from public.import_batch_chunks where id = p_chunk_id;
  if not found then
    raise exception 'Import chunk does not exist' using errcode = '55000';
  end if;
  select * into batch_row from public.import_batches where id = chunk_row.batch_id for update;
  select * into chunk_row from public.import_batch_chunks where id = p_chunk_id for update;
  if not found or chunk_row.status <> 'LEASED'
     or chunk_row.lease_token <> p_lease_token
     or chunk_row.lease_generation <> p_lease_generation
     or chunk_row.lease_expires_at <= transaction_timestamp()
     or chunk_row.cursor_version <> p_expected_cursor_version then
    raise exception 'Import chunk lease or cursor is stale' using errcode = '40001';
  end if;
  if batch_row.status in ('APPLIED', 'CANCELLED', 'FAILED') then
    raise exception 'Import batch is terminal' using errcode = '55000';
  end if;

  for row_value in select value from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(row_value) <> 'object'
       or not (row_value ? 'row_number')
       or jsonb_typeof(row_value -> 'row_number') <> 'number'
       or (row_value ->> 'row_number') !~ '^[0-9]+$' then
      raise exception 'Each import chunk row must contain numeric row_number' using errcode = '22023';
    end if;
    begin
      row_number_value := (row_value ->> 'row_number')::integer;
    exception when others then
      raise exception 'Import row_number is invalid' using errcode = '22023';
    end;
    if row_number_value < chunk_row.start_row_number or row_number_value > chunk_row.end_row_number
       or row_number_value = any(seen_rows) then
      raise exception 'Import row is outside the chunk or duplicated' using errcode = '22023';
    end if;
    seen_rows := array_append(seen_rows, row_number_value);
    raw_values_value := row_value -> 'raw_values';
    if raw_values_value is null or jsonb_typeof(raw_values_value) <> 'object' then
      select raw_values into raw_values_value from public.import_rows
      where batch_id = chunk_row.batch_id and row_number = row_number_value;
    end if;
    if raw_values_value is null or jsonb_typeof(raw_values_value) <> 'object' then
      raise exception 'Import row raw_values are required' using errcode = '22023';
    end if;
    if (select count(*) from jsonb_object_keys(raw_values_value)) > 50
       or exists (
         select 1 from jsonb_each_text(raw_values_value) f
         where length(f.value) > 1000000
            or f.value ~ '^[=+\-@]'
       ) then
      raise exception 'Import row contains too many fields, oversized cells, or a formula' using errcode = '22023';
    end if;
    normalized_values_value := case
      when row_value ? 'normalized_values' and jsonb_typeof(row_value -> 'normalized_values') = 'object'
        then row_value -> 'normalized_values'
      else null end;
    validation_errors_value := coalesce(row_value -> 'validation_errors', '[]'::jsonb);
    proposed_action_value := nullif(upper(btrim(coalesce(row_value ->> 'proposed_action', ''))), '');
    if jsonb_typeof(validation_errors_value) <> 'array'
       or (proposed_action_value is not null and proposed_action_value not in ('INSERT', 'UPDATE', 'SKIP', 'ERROR')) then
      raise exception 'Import row validation shape is invalid' using errcode = '22023';
    end if;
    insert into public.import_rows (
      batch_id, row_number, raw_values, normalized_values, proposed_action, validation_errors
    ) values (
      chunk_row.batch_id, row_number_value, raw_values_value, normalized_values_value,
      proposed_action_value, validation_errors_value
    ) on conflict (batch_id, row_number) do update set
      raw_values = excluded.raw_values,
      normalized_values = coalesce(excluded.normalized_values, public.import_rows.normalized_values),
      proposed_action = coalesce(excluded.proposed_action, public.import_rows.proposed_action),
      validation_errors = excluded.validation_errors;
    if row_value ? 'diffs' and jsonb_typeof(row_value -> 'diffs') <> 'array' then
      raise exception 'Import field diffs must be an array' using errcode = '22023';
    end if;
    for diff_value in select value from jsonb_array_elements(coalesce(row_value -> 'diffs', '[]'::jsonb)) loop
      field_name_value := btrim(coalesce(diff_value ->> 'field_name', ''));
      if jsonb_typeof(diff_value) <> 'object' or field_name_value = '' then
        raise exception 'Import field diff is invalid' using errcode = '22023';
      end if;
      insert into public.import_field_diffs (import_row_id, field_name, old_value, new_value, confirmed)
      select ir.id, field_name_value, diff_value -> 'old_value', diff_value -> 'new_value',
             coalesce((diff_value ->> 'confirmed')::boolean, false)
      from public.import_rows ir
      where ir.batch_id = chunk_row.batch_id and ir.row_number = row_number_value
      on conflict (import_row_id, field_name) do update set
        old_value = excluded.old_value, new_value = excluded.new_value, confirmed = excluded.confirmed;
    end loop;
  end loop;
  if cardinality(seen_rows) <> chunk_row.end_row_number - chunk_row.start_row_number + 1 then
    raise exception 'Import chunk must submit every row in its fixed range' using errcode = '22023';
  end if;
  update public.import_batch_chunks
  set status = 'COMPLETED', processing_cursor = end_row_number,
      cursor_version = cursor_version + 1, lease_token = null, lease_owner = null,
      lease_expires_at = null, completed_at = now()
  where id = chunk_row.id
  returning * into chunk_row;

  -- processing_cursor is the highest contiguous completed row, never merely
  -- the last worker to finish.  The batch row is already locked above.
  for range_row in
    select start_row_number, end_row_number, status
    from public.import_batch_chunks
    where batch_id = chunk_row.batch_id and phase = chunk_row.phase
    order by chunk_no
  loop
    exit when range_row.status <> 'COMPLETED'
      or range_row.start_row_number <> contiguous_cursor + 1;
    contiguous_cursor := range_row.end_row_number;
  end loop;
  update public.import_batches
  set processing_cursor = contiguous_cursor, cursor_version = cursor_version + 1
  where id = chunk_row.batch_id;

  if chunk_row.phase = 'PARSE' and not exists (
    select 1 from public.import_batch_chunks
    where batch_id = chunk_row.batch_id and phase = 'PARSE' and status <> 'COMPLETED'
  ) then
    update public.import_batches set status = 'VALIDATING', processing_cursor = 0, cursor_version = cursor_version + 1
    where id = chunk_row.batch_id;
    insert into public.import_batch_chunks (
      batch_id, phase, chunk_no, start_row_number, end_row_number, idempotency_key
    ) select batch_id, 'VALIDATE', chunk_no, start_row_number, end_row_number,
             'VALIDATE-' || batch_id::text || '-' || chunk_no::text
      from public.import_batch_chunks p
      where p.batch_id = chunk_row.batch_id and p.phase = 'PARSE'
    on conflict (batch_id, phase, chunk_no) do nothing;
  elsif chunk_row.phase = 'VALIDATE' and not exists (
    select 1 from public.import_batch_chunks
    where batch_id = chunk_row.batch_id and phase = 'VALIDATE' and status <> 'COMPLETED'
  ) then
    if exists (
      select 1 from public.import_rows
      where batch_id = chunk_row.batch_id and jsonb_array_length(validation_errors) > 0
    ) then
      update public.import_batches set status = 'FAILED', error_row_count = (
        select count(*) from public.import_rows where batch_id = chunk_row.batch_id and jsonb_array_length(validation_errors) > 0
      ), valid_row_count = (
        select count(*) from public.import_rows where batch_id = chunk_row.batch_id and jsonb_array_length(validation_errors) = 0
      ), row_count = (select count(*) from public.import_rows where batch_id = chunk_row.batch_id)
      where id = chunk_row.batch_id;
    else
      update public.import_batches set status = 'VALIDATED', error_row_count = 0,
        valid_row_count = (select count(*) from public.import_rows where batch_id = chunk_row.batch_id),
        row_count = (select count(*) from public.import_rows where batch_id = chunk_row.batch_id),
        validated_at = now(), processing_cursor = 0, cursor_version = cursor_version + 1
      where id = chunk_row.batch_id;
    end if;
  end if;
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'import_batch_chunks',
      result_entity_id = chunk_row.id, succeeded_at = now()
  where id = command_row.id;
  return chunk_row;
end;
$$;

create or replace function public.fail_import_chunk(
  p_chunk_id uuid,
  p_lease_token text,
  p_lease_generation bigint,
  p_expected_cursor_version bigint,
  p_error_code text,
  p_error_message text,
  p_retryable boolean,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.import_batch_chunks
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  actor_id uuid;
  command_row public.operation_commands;
  chunk_row public.import_batch_chunks;
  batch_row public.import_batches;
  canonical_fingerprint text;
  next_status text;
  retry_at timestamptz;
  batch_id_value uuid;
begin
  actor_id := private.require_import_worker();
  if p_chunk_id is null or btrim(coalesce(p_lease_token, '')) = ''
     or p_lease_generation is null or p_expected_cursor_version is null
     or btrim(coalesce(p_error_code, '')) = '' or btrim(coalesce(p_idempotency_key, '')) = '' then
    raise exception 'Import chunk failure fields are invalid' using errcode = '22023';
  end if;
  canonical_fingerprint := encode(digest(jsonb_build_object(
    'chunk_id', p_chunk_id, 'lease_generation', p_lease_generation,
    'cursor_version', p_expected_cursor_version, 'error_code', left(btrim(p_error_code), 100),
    'error_message', left(btrim(coalesce(p_error_message, '')), 500), 'retryable', coalesce(p_retryable, false)
  )::text, 'sha256'), 'hex');
  if p_request_fingerprint is distinct from canonical_fingerprint then
    raise exception 'Import chunk failure fingerprint mismatch' using errcode = '40001';
  end if;
  insert into public.operation_commands (
    operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id
  ) values ('FAIL_IMPORT_CHUNK', p_idempotency_key, canonical_fingerprint, actor_id)
  on conflict (operation_code, idempotency_key) do nothing;
  select * into command_row from public.operation_commands
  where operation_code = 'FAIL_IMPORT_CHUNK' and idempotency_key = p_idempotency_key for update;
  if command_row.actor_account_id <> actor_id or command_row.canonical_request_fingerprint <> canonical_fingerprint then
    raise exception 'Import chunk failure idempotency conflict' using errcode = '40001';
  end if;
  if command_row.status = 'SUCCEEDED' then
    select * into chunk_row from public.import_batch_chunks where id = command_row.result_entity_id;
    return chunk_row;
  end if;
  if command_row.status <> 'IN_PROGRESS' then raise exception 'Import chunk failure is not retryable' using errcode = '55000'; end if;
  select batch_id into batch_id_value from public.import_batch_chunks where id = p_chunk_id;
  if not found then raise exception 'Import chunk does not exist' using errcode = '55000'; end if;
  select * into batch_row from public.import_batches where id = batch_id_value for update;
  select * into chunk_row from public.import_batch_chunks where id = p_chunk_id for update;
  if not found or chunk_row.status <> 'LEASED' or chunk_row.lease_token <> p_lease_token
     or chunk_row.lease_generation <> p_lease_generation or chunk_row.lease_expires_at <= transaction_timestamp()
     or chunk_row.cursor_version <> p_expected_cursor_version then
    raise exception 'Import chunk lease or cursor is stale' using errcode = '40001';
  end if;
  if coalesce(p_retryable, false) and chunk_row.attempt_count < (
    select max_attempts from public.import_batches where id = chunk_row.batch_id
  ) then
    next_status := 'RETRY_WAIT';
    retry_at := transaction_timestamp() + make_interval(secs => least(3600, power(2::numeric, least(chunk_row.attempt_count, 10))::integer));
  else
    next_status := 'FAILED';
    retry_at := null;
  end if;
  update public.import_batch_chunks
  set status = next_status, cursor_version = cursor_version + 1,
      lease_token = null, lease_owner = null, lease_expires_at = null,
      next_retry_at = retry_at, last_error_code = left(btrim(p_error_code), 100),
      last_error_message = left(btrim(coalesce(p_error_message, '')), 500)
  where id = chunk_row.id returning * into chunk_row;
  if next_status = 'FAILED' then
    update public.import_batches set status = 'FAILED', last_error_code = left(btrim(p_error_code), 100),
      last_error_message = left(btrim(coalesce(p_error_message, '')), 500)
    where id = chunk_row.batch_id;
  end if;
  update public.operation_commands set status = 'SUCCEEDED', result_entity_type = 'import_batch_chunks',
    result_entity_id = chunk_row.id, succeeded_at = now() where id = command_row.id;
  return chunk_row;
end;
$$;

create or replace function public.cancel_import_batch(
  p_batch_id uuid,
  p_reason text,
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
  actor_id := private.execution_actor_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or actor_id is null or not (private.has_role('HR') or private.has_role('PROCUREMENT') or private.has_role('SYSTEM_ADMIN')) then
    raise exception using errcode = '42501', message = 'Import cancellation role is required';
  end if;
  if p_batch_id is null or btrim(coalesce(p_reason, '')) = '' or btrim(coalesce(p_idempotency_key, '')) = '' then
    raise exception 'Import cancellation fields are invalid' using errcode = '22023';
  end if;
  canonical_fingerprint := encode(digest(jsonb_build_object('batch_id', p_batch_id, 'reason', left(btrim(p_reason), 500))::text, 'sha256'), 'hex');
  if p_request_fingerprint is distinct from canonical_fingerprint then raise exception 'Import cancellation fingerprint mismatch' using errcode = '40001'; end if;
  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('CANCEL_IMPORT_BATCH', p_idempotency_key, canonical_fingerprint, actor_id)
  on conflict (operation_code, idempotency_key) do nothing;
  select * into command_row from public.operation_commands where operation_code = 'CANCEL_IMPORT_BATCH' and idempotency_key = p_idempotency_key for update;
  if command_row.actor_account_id <> actor_id or command_row.canonical_request_fingerprint <> canonical_fingerprint then raise exception 'Import cancellation idempotency conflict' using errcode = '40001'; end if;
  if command_row.status = 'SUCCEEDED' then select * into batch_row from public.import_batches where id = command_row.result_entity_id; return batch_row; end if;
  if command_row.status <> 'IN_PROGRESS' then raise exception 'Import cancellation is not retryable' using errcode = '55000'; end if;
  select * into batch_row from public.import_batches where id = p_batch_id for update;
  if not found or batch_row.status = 'APPLIED' then raise exception 'Applied import cannot be cancelled' using errcode = '55000'; end if;
  if batch_row.import_type = 'OPENING_BALANCE' and not private.has_role('SYSTEM_ADMIN') then
    raise exception using errcode = '42501', message = 'SYSTEM_ADMIN role is required for opening cancellation';
  elsif batch_row.import_type in ('SUPPLIERS', 'SUPPLIER_ITEMS') and not (private.has_role('HR') or private.has_role('PROCUREMENT')) then
    raise exception using errcode = '42501', message = 'HR or PROCUREMENT role is required for supplier cancellation';
  elsif batch_row.import_type not in ('OPENING_BALANCE', 'SUPPLIERS', 'SUPPLIER_ITEMS') and not private.has_role('HR') then
    raise exception using errcode = '42501', message = 'HR role is required for master cancellation';
  end if;
  update public.import_batch_chunks set status = case when status = 'COMPLETED' then status else 'FAILED' end,
    lease_token = null, lease_owner = null, lease_expires_at = null, next_retry_at = null,
    last_error_code = case when status = 'COMPLETED' then last_error_code else 'CANCELLED' end,
    last_error_message = case when status = 'COMPLETED' then last_error_message else left(btrim(p_reason), 500) end
  where batch_id = p_batch_id and status <> 'COMPLETED';
  update public.import_batches set status = 'CANCELLED', last_error_code = 'CANCELLED', last_error_message = left(btrim(p_reason), 500)
  where id = p_batch_id returning * into batch_row;
  update public.operation_commands set status = 'SUCCEEDED', result_entity_type = 'import_batches', result_entity_id = batch_row.id, succeeded_at = now() where id = command_row.id;
  return batch_row;
end;
$$;

create or replace function public.confirm_import_batch(
  p_batch_id uuid,
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
  actor_id := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or actor_id is null or btrim(coalesce(p_idempotency_key, '')) = '' then
    raise exception using errcode = '42501', message = 'Authenticated import confirmation is required';
  end if;
  canonical_fingerprint := encode(digest(jsonb_build_object('batch_id', p_batch_id)::text, 'sha256'), 'hex');
  if p_request_fingerprint is distinct from canonical_fingerprint then
    raise exception 'Import confirmation fingerprint mismatch' using errcode = '40001';
  end if;
  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('CONFIRM_IMPORT_BATCH', p_idempotency_key, canonical_fingerprint, actor_id)
  on conflict (operation_code, idempotency_key) do nothing;
  select * into command_row from public.operation_commands
  where operation_code = 'CONFIRM_IMPORT_BATCH' and idempotency_key = p_idempotency_key for update;
  if command_row.actor_account_id <> actor_id or command_row.canonical_request_fingerprint <> canonical_fingerprint then
    raise exception 'Import confirmation idempotency conflict' using errcode = '40001';
  end if;
  if command_row.status = 'SUCCEEDED' then
    select * into batch_row from public.import_batches where id = command_row.result_entity_id;
    return batch_row;
  end if;
  if command_row.status <> 'IN_PROGRESS' then raise exception 'Import confirmation is not retryable' using errcode = '55000'; end if;
  select * into batch_row from public.import_batches where id = p_batch_id for update;
  if not found or batch_row.status <> 'VALIDATED' then
    raise exception 'Only VALIDATED import batches can be confirmed' using errcode = '55000';
  end if;
  if batch_row.import_type = 'OPENING_BALANCE' and not private.has_role('SYSTEM_ADMIN') then
    raise exception using errcode = '42501', message = 'SYSTEM_ADMIN role is required for opening confirmation';
  elsif batch_row.import_type in ('SUPPLIERS', 'SUPPLIER_ITEMS') and not (private.has_role('HR') or private.has_role('PROCUREMENT')) then
    raise exception using errcode = '42501', message = 'HR or PROCUREMENT role is required for supplier confirmation';
  elsif batch_row.import_type not in ('OPENING_BALANCE', 'SUPPLIERS', 'SUPPLIER_ITEMS') and not private.has_role('HR') then
    raise exception using errcode = '42501', message = 'HR role is required for master confirmation';
  end if;
  update public.import_field_diffs d
  set confirmed = true
  from public.import_rows r
  where d.import_row_id = r.id and r.batch_id = p_batch_id;
  update public.import_batches
  set confirmed_at = now(), confirmed_by = actor_id
  where id = p_batch_id
  returning * into batch_row;
  update public.operation_commands set status = 'SUCCEEDED', result_entity_type = 'import_batches',
    result_entity_id = batch_row.id, succeeded_at = now() where id = command_row.id;
  return batch_row;
end;
$$;

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
  if command_row.actor_account_id <> actor_id or command_row.canonical_request_fingerprint <> canonical_fingerprint then
    raise exception 'Import apply claim idempotency conflict' using errcode = '40001';
  end if;
  if command_row.status = 'SUCCEEDED' then
    select * into batch_row from public.import_batches where id = command_row.result_entity_id;
    return batch_row;
  end if;
  if command_row.status <> 'IN_PROGRESS' then raise exception 'Import apply claim is not retryable' using errcode = '55000'; end if;
  select * into batch_row from public.import_batches where id = p_batch_id for update;
  if not found or batch_row.status not in ('VALIDATED', 'APPLYING')
     or (batch_row.status = 'APPLYING' and batch_row.lease_expires_at > transaction_timestamp()) then
    raise exception 'Import batch is not ready for APPLY lease' using errcode = '55000';
  end if;
  update public.import_batches
  set status = 'APPLYING', lease_token = encode(gen_random_bytes(24), 'hex'),
      lease_generation = lease_generation + 1, lease_owner = session_user,
      lease_expires_at = transaction_timestamp() + make_interval(secs => p_lease_seconds),
      attempt_count = attempt_count + 1, next_retry_at = null, cursor_version = cursor_version + 1
  where id = p_batch_id returning * into batch_row;
  update public.operation_commands set status = 'SUCCEEDED', result_entity_type = 'import_batches',
    result_entity_id = batch_row.id, succeeded_at = now() where id = command_row.id;
  return batch_row;
end;
$$;

create or replace function public.apply_import_batch(
  p_batch_id uuid,
  p_lease_token text,
  p_lease_generation bigint,
  p_expected_cursor_version bigint,
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
  row_record record;
  value_row jsonb;
  canonical_fingerprint text;
  entity_type text;
  target_institution uuid;
  target_supplier uuid;
  target_item uuid;
  opening_batch_id uuid;
  posting_id uuid;
  line_no integer := 0;
  opening_state public.system_cutover_state;
  warehouse_row public.warehouses;
  item_row public.uniform_items;
  quantity_value bigint;
  actor_is_system_admin boolean;
  actor_is_hr boolean;
  actor_is_procurement boolean;
  uploader_is_system_admin boolean;
  uploader_is_hr boolean;
  uploader_is_procurement boolean;
begin
  actor_id := private.require_import_worker();
  if p_batch_id is null or btrim(coalesce(p_lease_token, '')) = '' or p_lease_generation is null
     or p_expected_cursor_version is null or btrim(coalesce(p_idempotency_key, '')) = '' then
    raise exception 'Import apply fields are invalid' using errcode = '22023';
  end if;
  canonical_fingerprint := encode(digest(jsonb_build_object(
    'batch_id', p_batch_id, 'lease_generation', p_lease_generation,
    'cursor_version', p_expected_cursor_version
  )::text, 'sha256'), 'hex');
  if p_request_fingerprint is distinct from canonical_fingerprint then raise exception 'Import apply fingerprint mismatch' using errcode = '40001'; end if;
  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('APPLY_DURABLE_IMPORT', p_idempotency_key, canonical_fingerprint, actor_id)
  on conflict (operation_code, idempotency_key) do nothing;
  select * into command_row from public.operation_commands where operation_code = 'APPLY_DURABLE_IMPORT' and idempotency_key = p_idempotency_key for update;
  if command_row.actor_account_id <> actor_id or command_row.canonical_request_fingerprint <> canonical_fingerprint then raise exception 'Import apply idempotency conflict' using errcode = '40001'; end if;
  if command_row.status = 'SUCCEEDED' then select * into batch_row from public.import_batches where id = command_row.result_entity_id; return batch_row; end if;
  if command_row.status <> 'IN_PROGRESS' then raise exception 'Import apply is not retryable' using errcode = '55000'; end if;
  select * into batch_row from public.import_batches where id = p_batch_id for update;
  if not found or batch_row.status <> 'APPLYING' or batch_row.lease_token <> p_lease_token
     or batch_row.lease_generation <> p_lease_generation
     or batch_row.lease_expires_at <= transaction_timestamp()
     or batch_row.cursor_version <> p_expected_cursor_version then
    raise exception 'Import batch APPLY lease or cursor is stale' using errcode = '40001';
  end if;
  if exists (select 1 from public.import_rows where batch_id = p_batch_id and jsonb_array_length(validation_errors) > 0) then raise exception 'Import batch contains validation errors' using errcode = '22023'; end if;
  if exists (select 1 from public.import_field_diffs d join public.import_rows r on r.id = d.import_row_id
             where r.batch_id = p_batch_id and d.confirmed = false) then
    raise exception 'Import batch has unconfirmed field differences' using errcode = '55000';
  end if;
  if batch_row.confirmed_at is null or batch_row.confirmed_by is null then
    raise exception 'Import batch requires user confirmation before APPLY' using errcode = '55000';
  end if;
  entity_type := batch_row.import_type;
  select exists (select 1 from public.user_roles where account_id = actor_id and role_code = 'SYSTEM_ADMIN'),
         exists (select 1 from public.user_roles where account_id = actor_id and role_code = 'HR'),
         exists (select 1 from public.user_roles where account_id = actor_id and role_code = 'PROCUREMENT')
    into actor_is_system_admin, actor_is_hr, actor_is_procurement;
  select exists (select 1 from public.user_roles where account_id = batch_row.upload_started_by and role_code = 'SYSTEM_ADMIN'),
         exists (select 1 from public.user_roles where account_id = batch_row.upload_started_by and role_code = 'HR'),
         exists (select 1 from public.user_roles where account_id = batch_row.upload_started_by and role_code = 'PROCUREMENT')
    into uploader_is_system_admin, uploader_is_hr, uploader_is_procurement;
  if exists (select 1 from public.import_rows where batch_id = p_batch_id and proposed_action = 'ERROR') then
    raise exception 'Import batch contains ERROR preview rows' using errcode = '22023';
  end if;
  if entity_type = 'OPENING_BALANCE' and (not actor_is_system_admin or not uploader_is_system_admin) then
    raise exception 'SYSTEM_ADMIN role is required for opening apply' using errcode = '42501';
  elsif entity_type in ('SUPPLIERS', 'SUPPLIER_ITEMS') and (not (actor_is_hr or actor_is_procurement) or not (uploader_is_hr or uploader_is_procurement)) then
    raise exception 'HR or PROCUREMENT role is required for supplier apply' using errcode = '42501';
  elsif entity_type not in ('OPENING_BALANCE', 'SUPPLIERS', 'SUPPLIER_ITEMS') and (not actor_is_hr or not uploader_is_hr) then
    raise exception 'HR role is required for master apply' using errcode = '42501';
  end if;

  if entity_type = 'OPENING_BALANCE' then
    select * into opening_state from public.system_cutover_state where id = 1 for update;
    if opening_state.status <> 'PRE_CUTOVER' or opening_state.opening_import_batch_id is not null
       or opening_state.opening_posting_id is not null
       or exists (select 1 from public.inventory_postings where posting_kind <> 'OPENING') then
      raise exception 'Opening import requires the PRE_CUTOVER singleton' using errcode = '55000';
    end if;
    insert into public.opening_balance_batches (batch_no, source_filename, source_hash, created_by, status)
    values ('OPEN-' || upper(substr(replace(p_batch_id::text, '-', ''), 1, 20)), batch_row.original_filename, batch_row.file_sha256, actor_id, 'VALIDATED')
    returning id into opening_batch_id;
    for row_record in select * from public.import_rows where batch_id = p_batch_id order by row_number loop
      if row_record.proposed_action = 'SKIP' then
        update public.import_rows set applied_at = now() where id = row_record.id;
        continue;
      end if;
      value_row := coalesce(row_record.normalized_values, row_record.raw_values);
      if btrim(coalesce(value_row ->> 'warehouseCode', '')) = '' or btrim(coalesce(value_row ->> 'itemCode', '')) = ''
         or coalesce(value_row ->> 'quantity', '') !~ '^[0-9]{1,18}$' then
        raise exception 'Opening import row is invalid' using errcode = '22023';
      end if;
      insert into public.opening_balance_rows (batch_id, row_number, warehouse_code, item_code, quantity, status)
      values (opening_batch_id, row_record.row_number + 1, btrim(value_row ->> 'warehouseCode'), btrim(value_row ->> 'itemCode'), (value_row ->> 'quantity')::bigint, 'VALIDATED');
      update public.import_rows set applied_at = now() where id = row_record.id;
    end loop;
    if exists (select 1 from public.opening_balance_rows r left join public.warehouses w on w.code = r.warehouse_code and w.is_active left join public.uniform_items i on i.item_code = r.item_code and i.is_active where r.batch_id = opening_batch_id and (w.id is null or i.id is null)) then
      raise exception 'Opening import references missing or inactive warehouse/item' using errcode = '22023';
    end if;
    if exists (select 1 from public.opening_balance_rows where batch_id = opening_batch_id group by warehouse_code, item_code having count(*) > 1) then
      raise exception 'Opening import contains duplicate warehouse/item rows' using errcode = '22023';
    end if;
    insert into public.inventory_postings (idempotency_key, posting_kind, source_entity_id, posted_by)
    values ('OPENING-DURABLE-' || p_batch_id::text, 'OPENING', opening_batch_id, actor_id) returning id into posting_id;
    insert into public.opening_posting_sources (posting_id, batch_id) values (posting_id, opening_batch_id);
    for row_record in select w.id as warehouse_id, i.id as item_id, r.quantity from public.opening_balance_rows r join public.warehouses w on w.code = r.warehouse_code join public.uniform_items i on i.item_code = r.item_code where r.batch_id = opening_batch_id order by w.id, i.id loop
      line_no := line_no + 1;
      insert into public.inventory_ledger_entries (posting_id, line_no, warehouse_id, item_id, movement_kind, quantity_delta, occurred_on)
      values (posting_id, line_no, row_record.warehouse_id, row_record.item_id, 'OPENING_BALANCE', row_record.quantity, (now() at time zone 'Asia/Taipei')::date);
      insert into public.inventory_balances (warehouse_id, item_id, on_hand_quantity, version, last_posting_id)
      values (row_record.warehouse_id, row_record.item_id, row_record.quantity, 1, posting_id)
      on conflict (warehouse_id, item_id) do update set on_hand_quantity = excluded.on_hand_quantity, version = public.inventory_balances.version + 1, last_posting_id = posting_id, updated_at = now();
    end loop;
    update public.opening_balance_batches set status = 'APPLIED', row_count = (select count(*) from public.opening_balance_rows where batch_id = opening_batch_id), error_count = 0, applied_at = now(), applied_by = actor_id where id = opening_batch_id;
    update public.system_cutover_state set status = 'LIVE', opening_import_batch_id = p_batch_id, opening_posting_id = posting_id, cutover_at = now(), cutover_by = actor_id where id = 1;
  else
    for row_record in select * from public.import_rows where batch_id = p_batch_id order by row_number loop
      if row_record.proposed_action = 'SKIP' then
        update public.import_rows set applied_at = now() where id = row_record.id;
        continue;
      end if;
      value_row := coalesce(row_record.normalized_values, row_record.raw_values);
      if entity_type = 'INSTITUTIONS' then
        if btrim(coalesce(value_row ->> 'code', '')) = '' or btrim(coalesce(value_row ->> 'name', '')) = '' then raise exception 'Institution import row is invalid'; end if;
        insert into public.institutions (code, name, is_active) values (btrim(value_row ->> 'code'), btrim(value_row ->> 'name'), case when value_row ? 'isActive' then (value_row ->> 'isActive')::boolean else true end)
        on conflict (code) do update set name = excluded.name, is_active = case when value_row ? 'isActive' then excluded.is_active else public.institutions.is_active end;
      elsif entity_type = 'DEPARTMENTS' then
        select id into target_institution from public.institutions where code = btrim(value_row ->> 'institutionCode') and is_active for update;
        if target_institution is null or btrim(coalesce(value_row ->> 'code', '')) = '' or btrim(coalesce(value_row ->> 'name', '')) = '' then raise exception 'Department import row is invalid'; end if;
        insert into public.departments (institution_id, code, name, is_active) values (target_institution, btrim(value_row ->> 'code'), btrim(value_row ->> 'name'), case when value_row ? 'isActive' then (value_row ->> 'isActive')::boolean else true end)
        on conflict (institution_id, code) do update set name = excluded.name, is_active = case when value_row ? 'isActive' then excluded.is_active else public.departments.is_active end;
      elsif entity_type = 'UNIFORM_ITEMS' then
        if btrim(coalesce(value_row ->> 'code', '')) = '' or btrim(coalesce(value_row ->> 'name', '')) = '' or btrim(coalesce(value_row ->> 'unit', '')) = '' then raise exception 'Uniform item import row is invalid'; end if;
        insert into public.uniform_items (item_code, item_name, unit, size, category, season, is_active) values (btrim(value_row ->> 'code'), btrim(value_row ->> 'name'), btrim(value_row ->> 'unit'), nullif(btrim(value_row ->> 'size'), ''), nullif(btrim(value_row ->> 'category'), ''), nullif(btrim(value_row ->> 'season'), ''), case when value_row ? 'isActive' then (value_row ->> 'isActive')::boolean else true end)
        on conflict (item_code) do update set item_name = excluded.item_name, unit = excluded.unit, size = case when value_row ? 'size' and btrim(value_row ->> 'size') <> '' then excluded.size else public.uniform_items.size end, category = case when value_row ? 'category' and btrim(value_row ->> 'category') <> '' then excluded.category else public.uniform_items.category end, season = case when value_row ? 'season' and btrim(value_row ->> 'season') <> '' then excluded.season else public.uniform_items.season end, is_active = case when value_row ? 'isActive' then excluded.is_active else public.uniform_items.is_active end;
      elsif entity_type = 'SUPPLIERS' then
        if btrim(coalesce(value_row ->> 'supplierCode', '')) = '' or btrim(coalesce(value_row ->> 'name', '')) = '' then raise exception 'Supplier import row is invalid'; end if;
        insert into public.suppliers (supplier_code, name, default_currency, is_active) values (btrim(value_row ->> 'supplierCode'), btrim(value_row ->> 'name'), nullif(upper(btrim(value_row ->> 'defaultCurrency')), ''), case when value_row ? 'isActive' then (value_row ->> 'isActive')::boolean else true end)
        on conflict (supplier_code) do update set name = excluded.name, default_currency = case when value_row ? 'defaultCurrency' and btrim(value_row ->> 'defaultCurrency') <> '' then excluded.default_currency else public.suppliers.default_currency end, is_active = case when value_row ? 'isActive' then excluded.is_active else public.suppliers.is_active end;
      elsif entity_type = 'SUPPLIER_ITEMS' then
        select id into target_supplier from public.suppliers where supplier_code = btrim(value_row ->> 'supplierCode') and is_active for update;
        select id into target_item from public.uniform_items where item_code = btrim(value_row ->> 'itemCode') and is_active for update;
        if target_supplier is null or target_item is null or coalesce(value_row ->> 'minimumOrderQuantity', '') !~ '^[1-9][0-9]{0,17}$' then raise exception 'Supplier item import row is invalid'; end if;
        insert into public.supplier_uniform_items (supplier_id, item_id, minimum_order_quantity, supplier_item_code, is_active) values (target_supplier, target_item, (value_row ->> 'minimumOrderQuantity')::bigint, nullif(btrim(value_row ->> 'supplierItemCode'), ''), case when value_row ? 'isActive' then (value_row ->> 'isActive')::boolean else true end)
        on conflict (supplier_id, item_id) do update set minimum_order_quantity = excluded.minimum_order_quantity, supplier_item_code = case when value_row ? 'supplierItemCode' and btrim(value_row ->> 'supplierItemCode') <> '' then excluded.supplier_item_code else public.supplier_uniform_items.supplier_item_code end, is_active = case when value_row ? 'isActive' then excluded.is_active else public.supplier_uniform_items.is_active end;
      elsif entity_type = 'EMPLOYEES' then
        if btrim(coalesce(value_row ->> 'employeeNo', '')) = '' or btrim(coalesce(value_row ->> 'name', '')) = ''
           or btrim(coalesce(value_row ->> 'institutionCode', '')) = '' or btrim(coalesce(value_row ->> 'departmentCode', '')) = ''
           or coalesce(value_row ->> 'employmentStatus', '') not in ('ACTIVE', 'INACTIVE') then
          raise exception 'Employee import row is invalid' using errcode = '22023';
        end if;
        perform pg_advisory_xact_lock(hashtextextended('durable-employee:' || btrim(value_row ->> 'employeeNo'), 0));
        select id into target_institution from public.institutions where code = btrim(value_row ->> 'institutionCode') and is_active for update;
        if target_institution is null then raise exception 'Employee institution is missing or inactive' using errcode = '22023'; end if;
        select id into target_item from public.departments where institution_id = target_institution and code = btrim(value_row ->> 'departmentCode') and is_active for update;
        if target_item is null then raise exception 'Employee department is missing or inactive' using errcode = '22023'; end if;
        insert into public.employees (employee_no, name, institution_id, department_id, employment_status, job_title, hire_date, termination_date, note)
        values (btrim(value_row ->> 'employeeNo'), btrim(value_row ->> 'name'), target_institution, target_item,
          value_row ->> 'employmentStatus', nullif(btrim(value_row ->> 'jobTitle'), ''), nullif(value_row ->> 'hireDate', '')::date,
          nullif(value_row ->> 'terminationDate', '')::date, nullif(btrim(value_row ->> 'note'), ''))
        on conflict (employee_no) do update set name = excluded.name, institution_id = excluded.institution_id,
          department_id = excluded.department_id, employment_status = excluded.employment_status,
          job_title = case when value_row ? 'jobTitle' and btrim(value_row ->> 'jobTitle') <> '' then excluded.job_title else public.employees.job_title end,
          hire_date = case when value_row ? 'hireDate' and btrim(value_row ->> 'hireDate') <> '' then excluded.hire_date else public.employees.hire_date end,
          termination_date = case when value_row ? 'terminationDate' and btrim(value_row ->> 'terminationDate') <> '' then excluded.termination_date else public.employees.termination_date end,
          note = case when value_row ? 'note' and btrim(value_row ->> 'note') <> '' then excluded.note else public.employees.note end;
      else
        raise exception 'Unsupported durable import type' using errcode = '22023';
      end if;
      update public.import_rows set applied_at = now() where id = row_record.id;
    end loop;
  end if;
  update public.import_batches set status = 'APPLIED', applied_at = now(), applied_by = actor_id,
    processing_cursor = row_count, cursor_version = cursor_version + 1,
    lease_token = null, lease_owner = null, lease_expires_at = null, next_retry_at = null
  where id = p_batch_id returning * into batch_row;
  update public.operation_commands set status = 'SUCCEEDED', result_entity_type = 'import_batches', result_entity_id = batch_row.id, succeeded_at = now() where id = command_row.id;
  return batch_row;
end;
$$;

revoke all on function public.claim_import_chunk(uuid, text, integer, text, text) from public, anon, authenticated;
revoke all on function public.heartbeat_import_chunk(uuid, text, bigint, bigint, integer) from public, anon, authenticated;
revoke all on function public.complete_import_chunk(uuid, text, bigint, bigint, jsonb, text, text) from public, anon, authenticated;
revoke all on function public.fail_import_chunk(uuid, text, bigint, bigint, text, text, boolean, text, text) from public, anon, authenticated;
revoke all on function public.claim_import_apply(uuid, integer, text, text) from public, anon, authenticated;
revoke all on function public.apply_import_batch(uuid, text, bigint, bigint, text, text) from public, anon, authenticated;
grant execute on function public.claim_import_chunk(uuid, text, integer, text, text) to job_import_worker;
grant execute on function public.heartbeat_import_chunk(uuid, text, bigint, bigint, integer) to job_import_worker;
grant execute on function public.complete_import_chunk(uuid, text, bigint, bigint, jsonb, text, text) to job_import_worker;
grant execute on function public.fail_import_chunk(uuid, text, bigint, bigint, text, text, boolean, text, text) to job_import_worker;
grant execute on function public.claim_import_apply(uuid, integer, text, text) to job_import_worker;
grant execute on function public.apply_import_batch(uuid, text, bigint, bigint, text, text) to job_import_worker;
revoke all on function public.cancel_import_batch(uuid, text, text, text) from public, anon;
grant execute on function public.cancel_import_batch(uuid, text, text, text) to authenticated;
revoke all on function public.confirm_import_batch(uuid, text, text) from public, anon;
grant execute on function public.confirm_import_batch(uuid, text, text) to authenticated;
