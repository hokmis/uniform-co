-- Durable import upload/chunk foundation. Legacy direct master-import RPCs remain
-- available for compatibility; new workers can adopt this state machine without
-- placing source bytes or cursor state in a Vercel request.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'job_import_worker') then
    execute 'create role job_import_worker noinherit nologin';
  end if;
end;
$$;

create table public.import_batches (
  id uuid primary key default gen_random_uuid(),
  batch_no text not null unique check (btrim(batch_no) <> ''),
  import_type text not null check (import_type in (
    'INSTITUTIONS', 'DEPARTMENTS', 'EMPLOYEES', 'UNIFORM_ITEMS',
    'SUPPLIERS', 'SUPPLIER_ITEMS', 'OPENING_BALANCE'
  )),
  status text not null default 'AWAITING_UPLOAD' check (status in (
    'AWAITING_UPLOAD', 'UPLOADED', 'PARSING', 'VALIDATING', 'VALIDATED',
    'APPLYING', 'APPLIED', 'FAILED', 'CANCELLED'
  )),
  original_filename text not null check (btrim(original_filename) <> ''),
  expected_mime_type text not null check (btrim(expected_mime_type) <> ''),
  expected_size_bytes bigint not null check (expected_size_bytes > 0 and expected_size_bytes <= 10000000),
  file_sha256 text check (file_sha256 is null or file_sha256 ~ '^[0-9a-fA-F]{64}$'),
  storage_bucket text not null default 'uniform-imports' check (storage_bucket = 'uniform-imports'),
  storage_object_key text not null unique check (btrim(storage_object_key) <> ''),
  upload_expires_at timestamptz not null,
  mapping_version text not null check (btrim(mapping_version) <> ''),
  processing_cursor integer not null default 0 check (processing_cursor >= 0),
  cursor_version bigint not null default 0 check (cursor_version >= 0),
  lease_token text,
  lease_generation bigint not null default 0 check (lease_generation >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 5 check (max_attempts > 0),
  next_retry_at timestamptz,
  last_error_code text,
  last_error_message text,
  upload_started_at timestamptz not null default now(),
  upload_started_by uuid not null references public.app_accounts(id),
  uploaded_at timestamptz,
  uploaded_by uuid references public.app_accounts(id),
  validated_at timestamptz,
  applied_at timestamptz,
  applied_by uuid references public.app_accounts(id),
  row_count integer not null default 0 check (row_count >= 0),
  valid_row_count integer not null default 0 check (valid_row_count >= 0),
  error_row_count integer not null default 0 check (error_row_count >= 0),
  created_at timestamptz not null default now()
);

create table public.import_batch_chunks (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.import_batches(id),
  phase text not null check (phase in ('PARSE', 'VALIDATE', 'APPLY')),
  chunk_no integer not null check (chunk_no > 0),
  start_row_number integer not null check (start_row_number > 0),
  end_row_number integer not null check (end_row_number >= start_row_number),
  status text not null default 'PENDING' check (status in ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')),
  processing_cursor integer not null default 0 check (processing_cursor >= 0),
  cursor_version bigint not null default 0 check (cursor_version >= 0),
  lease_token text,
  lease_generation bigint not null default 0 check (lease_generation >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_retry_at timestamptz,
  last_error_code text,
  last_error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  idempotency_key text not null unique,
  unique (batch_id, phase, chunk_no),
  unique (batch_id, phase, start_row_number, end_row_number)
);

create table public.import_rows (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.import_batches(id),
  row_number integer not null check (row_number > 0),
  raw_values jsonb not null check (jsonb_typeof(raw_values) = 'object'),
  normalized_values jsonb check (normalized_values is null or jsonb_typeof(normalized_values) = 'object'),
  proposed_action text check (proposed_action is null or proposed_action in ('INSERT', 'UPDATE', 'SKIP', 'ERROR')),
  validation_errors jsonb not null default '[]'::jsonb check (jsonb_typeof(validation_errors) = 'array'),
  target_entity_id uuid,
  applied_at timestamptz,
  unique (batch_id, row_number)
);

create table public.import_field_diffs (
  id uuid primary key default gen_random_uuid(),
  import_row_id uuid not null references public.import_rows(id),
  field_name text not null check (btrim(field_name) <> ''),
  old_value jsonb,
  new_value jsonb,
  confirmed boolean not null default false,
  unique (import_row_id, field_name)
);

create or replace function private.prevent_terminal_import_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  if exists (
    select 1 from public.import_batches b
    where b.id = case when tg_table_name = 'import_batches' then old.id else old.batch_id end
      and b.status in ('APPLIED', 'CANCELLED')
  ) then
    raise exception 'Terminal import data is immutable' using errcode = '55000';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger import_batch_terminal_guard
before update or delete on public.import_batches
for each row execute function private.prevent_terminal_import_mutation();
create trigger import_chunk_terminal_guard
before update or delete on public.import_batch_chunks
for each row execute function private.prevent_terminal_import_mutation();
create trigger import_row_terminal_guard
before update or delete on public.import_rows
for each row execute function private.prevent_terminal_import_mutation();
create trigger import_diff_terminal_guard
before update or delete on public.import_field_diffs
for each row execute function private.prevent_terminal_import_mutation();

alter table public.import_batches enable row level security;
alter table public.import_batch_chunks enable row level security;
alter table public.import_rows enable row level security;
alter table public.import_field_diffs enable row level security;
create policy import_batches_read on public.import_batches
  for select to authenticated using (
    private.has_role('SYSTEM_ADMIN') or private.has_role('HR') or private.has_role('PROCUREMENT')
  );
create policy import_chunks_read on public.import_batch_chunks
  for select to authenticated using (
    private.has_role('SYSTEM_ADMIN') or private.has_role('HR') or private.has_role('PROCUREMENT')
  );
create policy import_rows_read on public.import_rows
  for select to authenticated using (
    private.has_role('SYSTEM_ADMIN') or private.has_role('HR') or private.has_role('PROCUREMENT')
  );
create policy import_diffs_read on public.import_field_diffs
  for select to authenticated using (
    private.has_role('SYSTEM_ADMIN') or private.has_role('HR') or private.has_role('PROCUREMENT')
  );
revoke all on table public.import_batches, public.import_batch_chunks,
  public.import_rows, public.import_field_diffs from public, anon, authenticated;
grant select on public.import_batches, public.import_batch_chunks,
  public.import_rows, public.import_field_diffs to authenticated;

create or replace function public.start_import_upload(
  p_import_type text,
  p_original_filename text,
  p_expected_mime_type text,
  p_expected_size_bytes bigint,
  p_mapping_version text,
  p_upload_ttl_seconds integer,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.import_batches
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  batch_row public.import_batches;
  batch_id uuid := gen_random_uuid();
  import_type text := upper(btrim(coalesce(p_import_type, '')));
  batch_no text;
  canonical_fingerprint text;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null then
    raise exception using errcode = '42501', message = 'Authenticated account is required';
  end if;
  if import_type not in ('INSTITUTIONS', 'DEPARTMENTS', 'EMPLOYEES', 'UNIFORM_ITEMS', 'SUPPLIERS', 'SUPPLIER_ITEMS', 'OPENING_BALANCE')
     or btrim(coalesce(p_original_filename, '')) = ''
     or btrim(coalesce(p_expected_mime_type, '')) = ''
     or p_expected_size_bytes is null or p_expected_size_bytes < 1 or p_expected_size_bytes > 10000000
     or btrim(coalesce(p_mapping_version, '')) = ''
     or p_upload_ttl_seconds is null or p_upload_ttl_seconds not between 60 and 3600
     or btrim(coalesce(p_idempotency_key, '')) = '' or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'Import upload fields are invalid' using errcode = '22023';
  end if;
  if import_type = 'OPENING_BALANCE' then
    if not private.has_role('SYSTEM_ADMIN') then raise exception using errcode = '42501', message = 'SYSTEM_ADMIN role is required'; end if;
    perform 1 from public.system_cutover_state where id = 1 and status = 'PRE_CUTOVER' for update;
    if not found then raise exception using errcode = '55000', message = 'Opening uploads require PRE_CUTOVER'; end if;
  elsif import_type in ('SUPPLIERS', 'SUPPLIER_ITEMS') then
    if not (private.has_role('HR') or private.has_role('PROCUREMENT')) then raise exception using errcode = '42501', message = 'Master-data role is required'; end if;
  elsif not private.has_role('HR') then
    raise exception using errcode = '42501', message = 'HR role is required';
  end if;

  canonical_fingerprint := encode(digest(jsonb_build_object('import_type', import_type, 'filename', left(btrim(p_original_filename), 255),
    'mime', left(btrim(p_expected_mime_type), 255), 'size', p_expected_size_bytes,
    'mapping_version', left(btrim(p_mapping_version), 100), 'ttl_seconds', p_upload_ttl_seconds)::text, 'sha256'), 'hex');
  if p_request_fingerprint <> canonical_fingerprint then
    raise exception using errcode = '40001', message = 'Request fingerprint does not match canonical upload payload';
  end if;
  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('START_IMPORT_UPLOAD_' || import_type, p_idempotency_key,
    canonical_fingerprint, current_account)
  on conflict (operation_code, idempotency_key) do nothing;
  select * into command_row from public.operation_commands
  where operation_code = 'START_IMPORT_UPLOAD_' || import_type and idempotency_key = p_idempotency_key for update;
  if command_row.actor_account_id <> current_account or command_row.canonical_request_fingerprint <> canonical_fingerprint then
    raise exception using errcode = '40001', message = 'Idempotency key conflicts with another request';
  end if;
  if command_row.status = 'SUCCEEDED' then
    select * into batch_row from public.import_batches where id = command_row.result_entity_id;
    return batch_row;
  end if;
  if command_row.status <> 'IN_PROGRESS' then raise exception using errcode = '55000', message = 'Import command is not retryable'; end if;

  batch_no := 'IMP-' || to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS') || '-' || upper(substr(replace(batch_id::text, '-', ''), 1, 8));
  insert into public.import_batches (
    id, batch_no, import_type, original_filename, expected_mime_type, expected_size_bytes,
    storage_object_key, upload_expires_at, mapping_version, upload_started_by
  ) values (
    batch_id, batch_no, import_type, left(btrim(p_original_filename), 255), left(btrim(p_expected_mime_type), 255),
    p_expected_size_bytes, 'imports/' || batch_id::text || '/' || gen_random_uuid()::text,
    now() + make_interval(secs => p_upload_ttl_seconds), left(btrim(p_mapping_version), 100), current_account
  ) returning * into batch_row;
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'import_batches', result_entity_id = batch_row.id, succeeded_at = now()
  where id = command_row.id;
  return batch_row;
end;
$$;

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
begin
  if session_user <> 'job_import_worker' then
    raise exception using errcode = '42501', message = 'job_import_worker role is required';
  end if;
  if p_actor_account_id is null or p_actor_account_id <> (select upload_started_by from public.import_batches where id = p_batch_id)
     or p_actual_size_bytes is null or p_actual_size_bytes < 1 or p_actual_size_bytes > 10000000
     or p_row_count is null or p_row_count < 1 or p_row_count > 10000
     or p_file_sha256 is null or p_file_sha256 !~ '^[0-9a-fA-F]{64}$'
     or btrim(coalesce(p_actual_mime_type, '')) = ''
     or btrim(coalesce(p_idempotency_key, '')) = '' or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'Verified upload metadata is invalid' using errcode = '22023';
  end if;
  canonical_fingerprint := encode(digest(jsonb_build_object('batch_id', p_batch_id, 'mime', p_actual_mime_type,
    'size', p_actual_size_bytes, 'sha256', lower(p_file_sha256), 'rows', p_row_count)::text, 'sha256'), 'hex');
  if p_request_fingerprint <> canonical_fingerprint then
    raise exception using errcode = '40001', message = 'Request fingerprint does not match canonical confirmation payload';
  end if;
  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('CONFIRM_IMPORT_UPLOAD', p_idempotency_key, canonical_fingerprint, p_actor_account_id)
  on conflict (operation_code, idempotency_key) do nothing;
  select * into command_row from public.operation_commands
  where operation_code = 'CONFIRM_IMPORT_UPLOAD' and idempotency_key = p_idempotency_key for update;
  if command_row.actor_account_id <> p_actor_account_id or command_row.canonical_request_fingerprint <> canonical_fingerprint then
    raise exception using errcode = '40001', message = 'Idempotency key conflicts with another request';
  end if;
  if command_row.status = 'SUCCEEDED' then select * into batch_row from public.import_batches where id = command_row.result_entity_id; return batch_row; end if;
  if command_row.status <> 'IN_PROGRESS' then raise exception using errcode = '55000', message = 'Import confirmation is not retryable'; end if;
  select * into batch_row from public.import_batches where id = p_batch_id for update;
  if not found or batch_row.status <> 'AWAITING_UPLOAD' or batch_row.upload_expires_at <= now()
     or p_actual_mime_type <> batch_row.expected_mime_type or p_actual_size_bytes <> batch_row.expected_size_bytes then
    raise exception 'Upload is expired or metadata does not match the declared object' using errcode = 'P0001';
  end if;
  if batch_row.import_type = 'OPENING_BALANCE' then
    perform 1 from public.system_cutover_state where id = 1 and status = 'PRE_CUTOVER' for update;
    if not found then raise exception using errcode = '55000', message = 'Opening uploads require PRE_CUTOVER'; end if;
  end if;
  -- The worker must first read the fixed private Storage key and write a
  -- verified sha256 metadata value. Caller-provided values are only claims;
  -- this database check is the durable confirmation boundary.
  select coalesce(o.metadata ->> 'mimetype', ''),
         nullif(o.metadata ->> 'size', '')::bigint,
         lower(coalesce(o.metadata ->> 'sha256', ''))
    into object_mime, object_size, object_hash
  from storage.objects o
  where o.bucket_id = batch_row.storage_bucket and o.name = batch_row.storage_object_key
  for update;
  if not found or object_mime <> batch_row.expected_mime_type
     or object_size <> batch_row.expected_size_bytes or object_hash <> lower(p_file_sha256) then
    raise exception 'Storage object is missing or verified metadata does not match' using errcode = 'P0001';
  end if;
  update public.import_batches
  set status = 'UPLOADED', file_sha256 = lower(p_file_sha256), uploaded_at = now(), uploaded_by = p_actor_account_id,
      row_count = p_row_count, valid_row_count = 0, error_row_count = 0
  where id = batch_row.id;
  insert into public.import_batch_chunks (
    batch_id, phase, chunk_no, start_row_number, end_row_number, idempotency_key
  ) values (
    batch_row.id, 'PARSE', 1, 1, p_row_count, 'PARSE-' || batch_row.id::text || '-1'
  ) on conflict (batch_id, phase, chunk_no) do nothing returning * into chunk_row;
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'import_batches', result_entity_id = batch_row.id, succeeded_at = now()
  where id = command_row.id;
  select * into batch_row from public.import_batches where id = batch_row.id;
  return batch_row;
end;
$$;

revoke all on function public.start_import_upload(text, text, text, bigint, text, integer, text, text) from public, anon;
grant execute on function public.start_import_upload(text, text, text, bigint, text, integer, text, text) to authenticated;
-- Provisioned deployments must create this NOLOGIN role and grant the function
-- only to it. Keeping the grant explicit prevents authenticated users from
-- forging Storage verification metadata; migration remains fail-closed until
-- the job role is provisioned.
do $$
begin
  execute 'grant execute on function public.confirm_import_upload(uuid, text, bigint, text, integer, uuid, text, text) to job_import_worker';
end;
$$;
revoke execute on function public.confirm_import_upload(uuid, text, bigint, text, integer, uuid, text, text) from public, anon, authenticated;
