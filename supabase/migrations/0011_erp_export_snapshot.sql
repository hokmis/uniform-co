-- ERP logical batches and immutable artifact revisions.

create table public.erp_export_batches (
  id uuid primary key default gen_random_uuid(),
  batch_no text not null unique check (btrim(batch_no) <> ''),
  export_kind text not null default 'SALES' check (export_kind = 'SALES'),
  distribution_date date not null,
  institution_id_snapshot uuid not null references public.institutions(id),
  institution_code_snapshot text not null,
  institution_name_snapshot text not null,
  status text not null default 'PREPARING' check (status in ('PREPARING', 'GENERATION_FAILED', 'GENERATED', 'DOWNLOADED', 'IMPORT_FAILED', 'IMPORT_CONFIRMED')),
  source_snapshot_version bigint not null default 1 check (source_snapshot_version > 0),
  source_snapshot_hash text not null,
  active_artifact_id uuid,
  current_artifact_id uuid,
  prepared_at timestamptz not null default now(),
  prepared_by uuid not null references public.app_accounts(id),
  generated_at timestamptz,
  generated_by uuid references public.app_accounts(id),
  downloaded_at timestamptz,
  import_failed_at timestamptz,
  import_confirmed_at timestamptz,
  import_confirmed_by uuid references public.app_accounts(id),
  last_error_code text,
  last_error_message text
);

create table public.erp_export_batch_lines (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.erp_export_batches(id),
  line_no integer not null check (line_no > 0),
  item_id uuid not null references public.uniform_items(id),
  item_code_snapshot text not null,
  item_name_snapshot text not null,
  unit_snapshot text not null,
  quantity bigint not null check (quantity > 0),
  unique (batch_id, line_no),
  unique (batch_id, id)
);

create table public.erp_export_source_links (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.erp_export_batches(id),
  batch_line_id uuid not null references public.erp_export_batch_lines(id),
  issue_line_id uuid references public.hr_issue_lines(id),
  return_line_id uuid references public.return_lines(id),
  source_quantity bigint not null check (source_quantity > 0),
  check (num_nonnulls(issue_line_id, return_line_id) = 1)
);

create table public.erp_export_artifacts (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.erp_export_batches(id),
  revision integer not null check (revision > 0),
  status text not null default 'PREPARING' check (status in ('PREPARING', 'READY', 'FAILED')),
  idempotency_key text not null unique,
  request_fingerprint text not null,
  supersedes_artifact_id uuid,
  is_current boolean not null default false,
  format_version text not null check (btrim(format_version) <> ''),
  source_snapshot_version bigint not null check (source_snapshot_version > 0),
  source_snapshot_hash text not null,
  storage_object_key text,
  payload_sha256 text,
  winning_attempt_id uuid,
  prepared_at timestamptz not null default now(),
  ready_at timestamptz,
  failed_at timestamptz,
  error_code text,
  error_message text,
  unique (batch_id, revision),
  unique (batch_id, id),
  foreign key (supersedes_artifact_id, batch_id)
    references public.erp_export_artifacts(id, batch_id)
);

create table public.erp_export_render_attempts (
  id uuid primary key default gen_random_uuid(),
  artifact_id uuid not null references public.erp_export_artifacts(id),
  attempt_no integer not null check (attempt_no > 0),
  attempt_key text not null unique,
  status text not null default 'PENDING' check (status in ('PENDING', 'RENDERING', 'SUCCEEDED', 'FAILED')),
  lease_token text,
  lease_generation bigint not null default 0 check (lease_generation >= 0),
  lease_expires_at timestamptz,
  temp_object_key text unique,
  payload_sha256 text,
  started_at timestamptz,
  uploaded_at timestamptz,
  succeeded_at timestamptz,
  failed_at timestamptz,
  error_code text,
  error_message text,
  unique (artifact_id, attempt_no),
  unique (artifact_id, id)
);

create table public.erp_export_download_events (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.erp_export_batches(id),
  artifact_id uuid not null references public.erp_export_artifacts(id),
  downloaded_at timestamptz not null default now(),
  downloaded_by uuid not null references public.app_accounts(id)
);

alter table public.erp_export_batches
  add constraint erp_export_batches_active_artifact_fk
  foreign key (active_artifact_id, id) references public.erp_export_artifacts(id, batch_id),
  add constraint erp_export_batches_current_artifact_fk
  foreign key (current_artifact_id, id) references public.erp_export_artifacts(id, batch_id);
alter table public.erp_export_artifacts
  add constraint erp_export_artifacts_winner_fk
  foreign key (id, winning_attempt_id) references public.erp_export_render_attempts(artifact_id, id);

create unique index erp_export_source_issue_once
  on public.erp_export_source_links(issue_line_id) where issue_line_id is not null;
create unique index erp_export_source_return_once
  on public.erp_export_source_links(return_line_id) where return_line_id is not null;
create unique index erp_export_one_preparing_artifact
  on public.erp_export_artifacts(batch_id) where status = 'PREPARING';
create unique index erp_export_one_current_artifact
  on public.erp_export_artifacts(batch_id) where status = 'READY' and is_current;

create or replace function private.prevent_erp_export_snapshot_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  if tg_table_name = 'erp_export_batches' then
    if old.batch_no <> new.batch_no or old.export_kind <> new.export_kind
       or old.distribution_date <> new.distribution_date
       or old.institution_id_snapshot <> new.institution_id_snapshot
       or old.institution_code_snapshot <> new.institution_code_snapshot
       or old.institution_name_snapshot <> new.institution_name_snapshot
       or old.source_snapshot_version <> new.source_snapshot_version
       or old.source_snapshot_hash <> new.source_snapshot_hash
       or old.prepared_at <> new.prepared_at or old.prepared_by <> new.prepared_by then
      raise exception 'ERP batch snapshot is immutable; use a lifecycle RPC';
    end if;
    return new;
  elsif tg_table_name = 'erp_export_artifacts' then
    if old.status = 'READY' then raise exception 'READY ERP artifacts are immutable'; end if;
  elsif exists (select 1 from public.erp_export_artifacts a where a.id = old.artifact_id and a.status = 'READY') then
    raise exception 'Attempts for READY artifacts are immutable';
  end if;
  return new;
end;
$$;

create trigger erp_export_batch_snapshot_guard
before update or delete on public.erp_export_batches
for each row execute function private.prevent_erp_export_snapshot_mutation();
create trigger erp_export_artifact_guard
before update or delete on public.erp_export_artifacts
for each row execute function private.prevent_erp_export_snapshot_mutation();
create trigger erp_export_attempt_guard
before update or delete on public.erp_export_render_attempts
for each row execute function private.prevent_erp_export_snapshot_mutation();

alter table public.erp_export_batches enable row level security;
alter table public.erp_export_batch_lines enable row level security;
alter table public.erp_export_source_links enable row level security;
alter table public.erp_export_artifacts enable row level security;
alter table public.erp_export_render_attempts enable row level security;
alter table public.erp_export_download_events enable row level security;
create policy erp_export_batches_read on public.erp_export_batches
  for select to authenticated using (private.has_role('HR') or private.has_role('WAREHOUSE'));
create policy erp_export_lines_read on public.erp_export_batch_lines
  for select to authenticated using (private.has_role('HR') or private.has_role('WAREHOUSE'));
create policy erp_export_links_read on public.erp_export_source_links
  for select to authenticated using (private.has_role('HR') or private.has_role('WAREHOUSE'));
create policy erp_export_artifacts_read on public.erp_export_artifacts
  for select to authenticated using (private.has_role('HR') or private.has_role('WAREHOUSE'));
create policy erp_export_attempts_read on public.erp_export_render_attempts
  for select to authenticated using (private.has_role('HR') or private.has_role('WAREHOUSE'));
create policy erp_export_downloads_read on public.erp_export_download_events
  for select to authenticated using (private.has_role('HR') or private.has_role('WAREHOUSE'));
revoke all on table public.erp_export_batches, public.erp_export_batch_lines, public.erp_export_source_links,
  public.erp_export_artifacts, public.erp_export_render_attempts, public.erp_export_download_events
  from public, anon, authenticated;
grant select on public.erp_export_batches, public.erp_export_batch_lines, public.erp_export_source_links,
  public.erp_export_artifacts, public.erp_export_render_attempts, public.erp_export_download_events to authenticated;

create or replace function public.create_erp_export_batch(
  p_distribution_date date,
  p_institution_id uuid,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.erp_export_batches
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  batch_row public.erp_export_batches;
  institution_row public.institutions;
  source_hash text;
  source_count integer;
  source_line record;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('HR') then
    raise exception using errcode = '42501', message = 'HR role is required';
  end if;
  if p_distribution_date is null or p_institution_id is null
     or btrim(coalesce(p_idempotency_key, '')) = '' or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'ERP batch fields are required';
  end if;
  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('CREATE_ERP_EXPORT_BATCH', p_idempotency_key, p_request_fingerprint, current_account)
  on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'CREATE_ERP_EXPORT_BATCH' and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' then
      select * into batch_row from public.erp_export_batches where id = command_row.result_entity_id;
      return batch_row;
    end if;
    raise exception using errcode = '40001', message = 'ERP batch creation is already in progress or failed';
  end if;
  select * into institution_row from public.institutions where id = p_institution_id and is_active;
  if institution_row.id is null then raise exception 'Institution is not active'; end if;
  select count(*) into source_count
  from public.hr_issue_lines l
  join public.hr_requests r on r.id = l.request_id
  where r.status = 'SHIPPED' and r.distribution_date = p_distribution_date
    and l.institution_id_snapshot = p_institution_id;
  if source_count = 0 then raise exception 'No eligible shipped issue lines for ERP export'; end if;
  for source_line in
    select l.id from public.hr_issue_lines l
    join public.hr_requests r on r.id = l.request_id
    where r.status = 'SHIPPED' and r.distribution_date = p_distribution_date
      and l.institution_id_snapshot = p_institution_id
    order by l.id for update
  loop
    null;
  end loop;
  if exists (
    select 1 from public.erp_export_source_links sl
    where sl.issue_line_id in (
      select l.id from public.hr_issue_lines l join public.hr_requests r on r.id = l.request_id
      where r.status = 'SHIPPED' and r.distribution_date = p_distribution_date
        and l.institution_id_snapshot = p_institution_id
    )
  ) then raise exception using errcode = '40001', message = 'An eligible issue line is already in an ERP export batch'; end if;
  select md5(coalesce(string_agg(format('%s:%s:%s', l.id, l.item_id, l.quantity), '| ' order by l.id), '')) into source_hash
  from public.hr_issue_lines l
  join public.hr_requests r on r.id = l.request_id
  where r.status = 'SHIPPED' and r.distribution_date = p_distribution_date
    and l.institution_id_snapshot = p_institution_id;
  insert into public.erp_export_batches (
    batch_no, distribution_date, institution_id_snapshot, institution_code_snapshot,
    institution_name_snapshot, status, source_snapshot_hash, prepared_by
  ) values (
    'ERP-' || to_char(p_distribution_date, 'YYYYMMDD') || '-' || substring(gen_random_uuid()::text from 1 for 8),
    p_distribution_date, institution_row.id, institution_row.code, institution_row.name,
    'PREPARING', source_hash, current_account
  ) returning * into batch_row;
  insert into public.erp_export_batch_lines (
    batch_id, line_no, item_id, item_code_snapshot, item_name_snapshot, unit_snapshot, quantity
  )
  select batch_row.id, row_number() over (order by l.item_id)::integer, l.item_id,
    max(l.item_code_snapshot), max(l.item_name_snapshot), max(l.unit_snapshot), sum(l.quantity)
  from public.hr_issue_lines l
  join public.hr_requests r on r.id = l.request_id
  where r.status = 'SHIPPED' and r.distribution_date = p_distribution_date
    and l.institution_id_snapshot = p_institution_id
  group by l.item_id;
  insert into public.erp_export_source_links (batch_id, batch_line_id, issue_line_id, source_quantity)
  select batch_row.id, bl.id, l.id, l.quantity
  from public.hr_issue_lines l
  join public.hr_requests r on r.id = l.request_id
  join public.erp_export_batch_lines bl on bl.batch_id = batch_row.id and bl.item_id = l.item_id
  where r.status = 'SHIPPED' and r.distribution_date = p_distribution_date
    and l.institution_id_snapshot = p_institution_id;
  update public.operation_commands set status = 'SUCCEEDED', result_entity_type = 'erp_export_batches', result_entity_id = batch_row.id, succeeded_at = now() where id = command_row.id;
  return batch_row;
end;
$$;

create or replace function public.request_erp_artifact(
  p_batch_id uuid,
  p_format_version text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.erp_export_artifacts
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  batch_row public.erp_export_batches;
  artifact_row public.erp_export_artifacts;
  next_revision integer;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('HR') then
    raise exception using errcode = '42501', message = 'HR role is required';
  end if;
  if btrim(coalesce(p_format_version, '')) = '' or btrim(coalesce(p_idempotency_key, '')) = ''
     or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'ERP artifact fields are required';
  end if;
  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('REQUEST_ERP_ARTIFACT', p_idempotency_key, p_request_fingerprint, current_account)
  on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'REQUEST_ERP_ARTIFACT' and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' then
      select * into artifact_row from public.erp_export_artifacts where id = command_row.result_entity_id;
      return artifact_row;
    end if;
    raise exception using errcode = '40001', message = 'ERP artifact request is already in progress or failed';
  end if;
  select * into batch_row from public.erp_export_batches where id = p_batch_id for update;
  if batch_row.id is null or batch_row.status not in ('PREPARING', 'GENERATION_FAILED', 'IMPORT_FAILED') then
    raise exception 'Batch is not ready for an artifact revision';
  end if;
  if batch_row.active_artifact_id is not null or exists (select 1 from public.erp_export_artifacts a where a.batch_id = p_batch_id and a.status = 'PREPARING') then
    raise exception using errcode = '40001', message = 'Another ERP artifact revision is active';
  end if;
  select coalesce(max(revision), 0) + 1 into next_revision from public.erp_export_artifacts where batch_id = p_batch_id;
  insert into public.erp_export_artifacts (
    batch_id, revision, status, idempotency_key, request_fingerprint,
    supersedes_artifact_id, format_version, source_snapshot_version, source_snapshot_hash
  ) values (
    p_batch_id, next_revision, 'PREPARING', p_idempotency_key, p_request_fingerprint,
    batch_row.current_artifact_id, left(btrim(p_format_version), 80), batch_row.source_snapshot_version, batch_row.source_snapshot_hash
  ) returning * into artifact_row;
  insert into public.erp_export_render_attempts (artifact_id, attempt_no, attempt_key)
  values (artifact_row.id, 1, p_idempotency_key || ':attempt:1');
  update public.erp_export_batches set active_artifact_id = artifact_row.id where id = p_batch_id;
  update public.operation_commands set status = 'SUCCEEDED', result_entity_type = 'erp_export_artifacts', result_entity_id = artifact_row.id, succeeded_at = now() where id = command_row.id;
  return artifact_row;
end;
$$;

revoke all on function public.create_erp_export_batch(date, uuid, text, text) from public, anon;
revoke all on function public.request_erp_artifact(uuid, text, text, text) from public, anon;
grant execute on function public.create_erp_export_batch(date, uuid, text, text) to authenticated;
grant execute on function public.request_erp_artifact(uuid, text, text, text) to authenticated;
