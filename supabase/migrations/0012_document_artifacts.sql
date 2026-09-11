-- Versioned, immutable PDF document artifacts and render attempts.

create table public.document_artifact_families (
  id uuid primary key default gen_random_uuid(),
  document_type text not null check (document_type in ('HR_REQUEST', 'WAREHOUSE_SHIPMENT', 'REPLENISHMENT', 'STOCKTAKE', 'RETURN_NOTE', 'SEASONAL_APPROVAL', 'PURCHASE_ORDER', 'PURCHASE_RECEIPT')),
  document_id uuid not null,
  artifact_kind text not null default 'PDF',
  source_snapshot_version bigint not null check (source_snapshot_version > 0),
  source_snapshot_hash text not null,
  created_at timestamptz not null default now(),
  unique (document_type, document_id, artifact_kind),
  unique (id, document_type, document_id, artifact_kind)
);

create table public.document_artifacts (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.document_artifact_families(id),
  revision integer not null check (revision > 0),
  status text not null default 'PREPARING' check (status in ('PREPARING', 'READY', 'FAILED')),
  idempotency_key text not null unique,
  request_fingerprint text not null,
  template_version text not null check (btrim(template_version) <> ''),
  source_snapshot_version bigint not null check (source_snapshot_version > 0),
  source_snapshot_hash text not null,
  storage_object_key text,
  payload_sha256 text,
  winning_attempt_id uuid,
  supersedes_artifact_id uuid,
  is_current boolean not null default false,
  prepared_at timestamptz not null default now(),
  ready_at timestamptz,
  failed_at timestamptz,
  error_code text,
  error_message text,
  unique (family_id, revision),
  unique (family_id, id),
  foreign key (supersedes_artifact_id, family_id) references public.document_artifacts(id, family_id)
);

create table public.document_render_attempts (
  id uuid primary key default gen_random_uuid(),
  artifact_id uuid not null references public.document_artifacts(id),
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

alter table public.document_artifacts
  add constraint document_artifacts_winner_fk
  foreign key (id, winning_attempt_id) references public.document_render_attempts(artifact_id, id);

create unique index document_artifacts_one_preparing
  on public.document_artifacts(family_id) where status = 'PREPARING';
create unique index document_artifacts_one_current
  on public.document_artifacts(family_id) where status = 'READY' and is_current;

create or replace function private.prevent_ready_document_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  if tg_table_name = 'document_artifact_families' then
    raise exception 'Document family snapshot is immutable';
  elsif tg_table_name = 'document_artifacts' and old.status = 'READY' then
    raise exception 'READY document artifacts are immutable';
  elsif tg_table_name = 'document_render_attempts'
    and exists (select 1 from public.document_artifacts a where a.id = old.artifact_id and a.status = 'READY') then
    raise exception 'Attempts for READY document artifacts are immutable';
  end if;
  return new;
end;
$$;

create trigger document_family_immutable_guard
before update or delete on public.document_artifact_families
for each row execute function private.prevent_ready_document_mutation();
create trigger document_artifact_immutable_guard
before update or delete on public.document_artifacts
for each row execute function private.prevent_ready_document_mutation();
create trigger document_attempt_immutable_guard
before update or delete on public.document_render_attempts
for each row execute function private.prevent_ready_document_mutation();

alter table public.document_artifact_families enable row level security;
alter table public.document_artifacts enable row level security;
alter table public.document_render_attempts enable row level security;
create policy document_families_read on public.document_artifact_families
  for select to authenticated using (
    private.has_role('HR') or private.has_role('WAREHOUSE') or private.has_role('PROCUREMENT') or private.has_role('CEO')
  );
create policy document_artifacts_read on public.document_artifacts
  for select to authenticated using (
    private.has_role('HR') or private.has_role('WAREHOUSE') or private.has_role('PROCUREMENT') or private.has_role('CEO')
  );
create policy document_attempts_read on public.document_render_attempts
  for select to authenticated using (
    private.has_role('HR') or private.has_role('WAREHOUSE') or private.has_role('PROCUREMENT') or private.has_role('CEO')
  );
revoke all on table public.document_artifact_families, public.document_artifacts, public.document_render_attempts
  from public, anon, authenticated;
grant select on public.document_artifact_families, public.document_artifacts, public.document_render_attempts to authenticated;

create or replace function public.request_document_pdf(
  p_document_type text,
  p_document_id uuid,
  p_template_version text,
  p_source_snapshot_version bigint,
  p_source_snapshot_hash text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.document_artifacts
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  family_row public.document_artifact_families;
  artifact_row public.document_artifacts;
  next_revision integer;
  document_family_id uuid;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' or current_account is null then
    raise exception using errcode = '42501', message = 'Authenticated account is required';
  end if;
  if p_document_type not in ('HR_REQUEST', 'WAREHOUSE_SHIPMENT', 'REPLENISHMENT', 'STOCKTAKE', 'RETURN_NOTE', 'SEASONAL_APPROVAL', 'PURCHASE_ORDER', 'PURCHASE_RECEIPT')
     or p_document_id is null or btrim(coalesce(p_template_version, '')) = ''
     or p_source_snapshot_version <= 0 or btrim(coalesce(p_source_snapshot_hash, '')) = ''
     or btrim(coalesce(p_idempotency_key, '')) = '' or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'PDF artifact fields are invalid';
  end if;
  if not (
    (p_document_type = 'HR_REQUEST' and private.has_role('HR') and exists (select 1 from public.hr_requests where id = p_document_id))
    or (p_document_type = 'WAREHOUSE_SHIPMENT' and private.has_role('WAREHOUSE') and exists (select 1 from public.warehouse_shipments where id = p_document_id))
    or (p_document_type = 'REPLENISHMENT' and private.has_role('HR') and exists (select 1 from public.replenishment_requests where id = p_document_id))
    or (p_document_type = 'STOCKTAKE' and (private.has_role('HR') or private.has_role('WAREHOUSE')) and exists (select 1 from public.stocktakes where id = p_document_id))
    or (p_document_type = 'RETURN_NOTE' and private.has_role('HR') and exists (select 1 from public.return_notes where id = p_document_id))
    or (p_document_type = 'SEASONAL_APPROVAL' and (private.has_role('HR') or private.has_role('CEO')) and exists (select 1 from public.seasonal_approvals where id = p_document_id))
    or (p_document_type = 'PURCHASE_ORDER' and (private.has_role('PROCUREMENT') or private.has_role('WAREHOUSE')) and exists (select 1 from public.purchase_orders where id = p_document_id))
    or (p_document_type = 'PURCHASE_RECEIPT' and private.has_role('WAREHOUSE') and exists (select 1 from public.purchase_receipts where id = p_document_id))
  ) then raise exception using errcode = '42501', message = 'Not authorized for this document'; end if;
  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('REQUEST_DOCUMENT_PDF', p_idempotency_key, p_request_fingerprint, current_account)
  on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'REQUEST_DOCUMENT_PDF' and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' then
      select * into artifact_row from public.document_artifacts where id = command_row.result_entity_id;
      return artifact_row;
    end if;
    raise exception using errcode = '40001', message = 'PDF artifact request is already in progress or failed';
  end if;
  select id into document_family_id from public.document_artifact_families
  where document_type = p_document_type and document_id = p_document_id and artifact_kind = 'PDF'
  for update;
  if document_family_id is null then
    insert into public.document_artifact_families (
      document_type, document_id, artifact_kind, source_snapshot_version, source_snapshot_hash
    ) values (
      p_document_type, p_document_id, 'PDF', p_source_snapshot_version, p_source_snapshot_hash
    ) returning id into document_family_id;
  else
    select * into family_row from public.document_artifact_families where id = document_family_id;
    if family_row.source_snapshot_version <> p_source_snapshot_version or family_row.source_snapshot_hash <> p_source_snapshot_hash then
      raise exception 'PDF source snapshot does not match the document family';
    end if;
  end if;
  if exists (select 1 from public.document_artifacts da where da.family_id = document_family_id and da.status = 'PREPARING') then
    raise exception using errcode = '40001', message = 'Another PDF revision is active';
  end if;
  select coalesce(max(da.revision), 0) + 1 into next_revision from public.document_artifacts da where da.family_id = document_family_id;
  insert into public.document_artifacts (
    family_id, revision, status, idempotency_key, request_fingerprint, template_version,
    source_snapshot_version, source_snapshot_hash, supersedes_artifact_id
  ) values (
    document_family_id, next_revision, 'PREPARING', p_idempotency_key, p_request_fingerprint,
    left(btrim(p_template_version), 80), p_source_snapshot_version, p_source_snapshot_hash,
    (select da.id from public.document_artifacts da where da.family_id = document_family_id and da.status = 'READY' and da.is_current limit 1)
  ) returning * into artifact_row;
  insert into public.document_render_attempts (artifact_id, attempt_no, attempt_key)
  values (artifact_row.id, 1, p_idempotency_key || ':attempt:1');
  update public.operation_commands set status = 'SUCCEEDED', result_entity_type = 'document_artifacts', result_entity_id = artifact_row.id, succeeded_at = now() where id = command_row.id;
  return artifact_row;
end;
$$;

revoke all on function public.request_document_pdf(text, uuid, text, bigint, text, text, text) from public, anon;
grant execute on function public.request_document_pdf(text, uuid, text, bigint, text, text, text) to authenticated;
