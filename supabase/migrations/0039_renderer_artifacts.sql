-- Forward-only PDF/ERP renderer worker lifecycle.
-- Request RPCs stop at PREPARING/PENDING; trusted workers publish only after
-- lease-fenced Storage metadata verification.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'job_document_renderer') then
    execute 'create role job_document_renderer noinherit nologin';
  else execute 'alter role job_document_renderer nologin noinherit'; end if;
  if not exists (select 1 from pg_roles where rolname = 'job_erp_renderer') then
    execute 'create role job_erp_renderer noinherit nologin';
  else execute 'alter role job_erp_renderer nologin noinherit'; end if;
end;
$$;

alter table public.document_artifact_families
  add column if not exists active_artifact_id uuid,
  add column if not exists current_artifact_id uuid;
alter table public.document_artifacts
  add column if not exists payload_size_bytes bigint,
  add column if not exists max_attempts integer not null default 5;
alter table public.document_render_attempts
  add column if not exists payload_size_bytes bigint;
alter table public.erp_export_artifacts
  add column if not exists payload_size_bytes bigint,
  add column if not exists max_attempts integer not null default 5;
alter table public.erp_export_render_attempts
  add column if not exists payload_size_bytes bigint;

-- The original schemas only had (family_id,id)/(batch_id,id) uniques.  The
-- pointer FKs below use the reverse column order so add matching targets
-- before adding the constraints (required on both fresh and upgraded DBs).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'document_artifacts_id_family_key') then
    alter table public.document_artifacts add constraint document_artifacts_id_family_key unique (id, family_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'erp_export_artifacts_id_batch_key') then
    alter table public.erp_export_artifacts add constraint erp_export_artifacts_id_batch_key unique (id, batch_id);
  end if;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'document_families_active_artifact_fk') then
    alter table public.document_artifact_families add constraint document_families_active_artifact_fk
      foreign key (active_artifact_id, id) references public.document_artifacts(id, family_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'document_families_current_artifact_fk') then
    alter table public.document_artifact_families add constraint document_families_current_artifact_fk
      foreign key (current_artifact_id, id) references public.document_artifacts(id, family_id);
  end if;
end;
$$;

-- Existing PREPARING/READY rows are promoted to pointers without changing
-- their immutable artifact rows. Operators must reconcile any duplicate rows.
update public.document_artifact_families f
set current_artifact_id = (
  select a.id
  from public.document_artifacts a
  where a.family_id = f.id
    and a.status = 'READY'
    and a.is_current
  order by a.revision desc
  limit 1
)
where f.current_artifact_id is null;
update public.document_artifact_families f
set active_artifact_id = (
  select a.id
  from public.document_artifacts a
  where a.family_id = f.id
    and a.status = 'PREPARING'
  order by a.revision desc
  limit 1
)
where f.active_artifact_id is null;

-- Keep the legacy request RPCs compatible with the new pointer-based worker:
-- their INSERT of a PREPARING artifact automatically claims the family/batch
-- root in the same transaction.
create or replace function private.bind_new_document_artifact_pointer()
returns trigger language plpgsql security definer set search_path = pg_catalog, private as $$
begin
  if new.status = 'PREPARING' then
    update public.document_artifact_families set active_artifact_id = new.id where id = new.family_id and active_artifact_id is null;
  end if;
  return new;
end; $$;
drop trigger if exists bind_document_artifact_pointer on public.document_artifacts;
create trigger bind_document_artifact_pointer after insert on public.document_artifacts for each row execute function private.bind_new_document_artifact_pointer();
create or replace function private.bind_new_erp_artifact_pointer()
returns trigger language plpgsql security definer set search_path = pg_catalog, private as $$
begin
  if new.status = 'PREPARING' then
    update public.erp_export_batches set active_artifact_id = new.id where id = new.batch_id and active_artifact_id is null;
  end if;
  return new;
end; $$;
drop trigger if exists bind_erp_artifact_pointer on public.erp_export_artifacts;
create trigger bind_erp_artifact_pointer after insert on public.erp_export_artifacts for each row execute function private.bind_new_erp_artifact_pointer();

-- READY payloads remain immutable; only the derived current marker may move
-- when a newer revision wins.  The original guards rejected that transition.
create or replace function private.prevent_ready_document_mutation()
returns trigger language plpgsql security definer set search_path = pg_catalog, private as $$
begin
  if tg_table_name='document_artifact_families' then
    if tg_op = 'DELETE' then raise exception 'Document family is immutable'; end if;
    if old.document_type<>new.document_type or old.document_id<>new.document_id or old.artifact_kind<>new.artifact_kind then raise exception 'Document family identity is immutable'; end if;
    if old.artifact_kind<>'DRAFT_WATERMARK' and (old.source_snapshot_version<>new.source_snapshot_version or old.source_snapshot_hash<>new.source_snapshot_hash) then raise exception 'Formal document family snapshot is immutable'; end if;
  elsif tg_table_name='document_artifacts' and old.status='READY' then
    if tg_op = 'DELETE' then raise exception 'READY document payload is immutable'; end if;
      if old.id<>new.id or old.family_id<>new.family_id or old.revision<>new.revision or old.idempotency_key<>new.idempotency_key or old.request_fingerprint<>new.request_fingerprint or old.supersedes_artifact_id is distinct from new.supersedes_artifact_id or old.template_version<>new.template_version or old.source_snapshot_version<>new.source_snapshot_version or old.source_snapshot_hash<>new.source_snapshot_hash or old.storage_object_key is distinct from new.storage_object_key or old.payload_sha256 is distinct from new.payload_sha256 or old.payload_size_bytes is distinct from new.payload_size_bytes or old.winning_attempt_id is distinct from new.winning_attempt_id or old.ready_at is distinct from new.ready_at or old.failed_at is distinct from new.failed_at or old.error_code is distinct from new.error_code or old.error_message is distinct from new.error_message or old.max_attempts is distinct from new.max_attempts or new.status<>'READY' or new.is_current and not old.is_current then raise exception 'READY document payload is immutable'; end if;
  elsif tg_table_name='document_render_attempts' and exists(select 1 from public.document_artifacts a where a.id=old.artifact_id and a.status='READY') then
    raise exception 'Attempts for READY document artifacts are immutable';
  end if;
  return new;
end; $$;
create or replace function private.prevent_erp_export_snapshot_mutation()
returns trigger language plpgsql security definer set search_path = pg_catalog, private as $$
begin
  if tg_table_name='erp_export_batches' then
    if old.batch_no<>new.batch_no or old.export_kind<>new.export_kind or old.distribution_date<>new.distribution_date or old.institution_id_snapshot<>new.institution_id_snapshot or old.institution_code_snapshot<>new.institution_code_snapshot or old.institution_name_snapshot<>new.institution_name_snapshot or old.source_snapshot_version<>new.source_snapshot_version or old.source_snapshot_hash<>new.source_snapshot_hash or old.prepared_at<>new.prepared_at or old.prepared_by<>new.prepared_by then raise exception 'ERP batch snapshot is immutable'; end if;
  elsif tg_table_name='erp_export_artifacts' then
    if old.status='READY' then
      if tg_op = 'DELETE' then raise exception 'READY ERP payload is immutable'; end if;
      if old.id<>new.id or old.batch_id<>new.batch_id or old.revision<>new.revision or old.idempotency_key<>new.idempotency_key or old.request_fingerprint<>new.request_fingerprint or old.supersedes_artifact_id is distinct from new.supersedes_artifact_id or old.format_version<>new.format_version or old.source_snapshot_version<>new.source_snapshot_version or old.source_snapshot_hash<>new.source_snapshot_hash or old.storage_object_key is distinct from new.storage_object_key or old.payload_sha256 is distinct from new.payload_sha256 or old.payload_size_bytes is distinct from new.payload_size_bytes or old.winning_attempt_id is distinct from new.winning_attempt_id or old.ready_at is distinct from new.ready_at or old.failed_at is distinct from new.failed_at or old.error_code is distinct from new.error_code or old.error_message is distinct from new.error_message or old.max_attempts is distinct from new.max_attempts or new.status<>'READY' or new.is_current and not old.is_current then raise exception 'READY ERP payload is immutable'; end if;
    end if;
  elsif tg_table_name='erp_export_render_attempts' and exists(select 1 from public.erp_export_artifacts a where a.id=old.artifact_id and a.status='READY') then raise exception 'Attempts for READY ERP artifacts are immutable'; end if;
  return new;
end; $$;

alter table public.document_artifacts drop constraint if exists document_artifacts_payload_sha256_format;
alter table public.document_artifacts add constraint document_artifacts_payload_sha256_format check (payload_sha256 is null or payload_sha256 ~ '^[0-9a-fA-F]{64}$');
alter table public.document_render_attempts drop constraint if exists document_attempts_payload_sha256_format;
alter table public.document_render_attempts add constraint document_attempts_payload_sha256_format check (payload_sha256 is null or payload_sha256 ~ '^[0-9a-fA-F]{64}$');
alter table public.erp_export_artifacts drop constraint if exists erp_artifacts_payload_sha256_format;
alter table public.erp_export_artifacts add constraint erp_artifacts_payload_sha256_format check (payload_sha256 is null or payload_sha256 ~ '^[0-9a-fA-F]{64}$');
alter table public.erp_export_render_attempts drop constraint if exists erp_attempts_payload_sha256_format;
alter table public.erp_export_render_attempts add constraint erp_attempts_payload_sha256_format check (payload_sha256 is null or payload_sha256 ~ '^[0-9a-fA-F]{64}$');

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('uniform-pdf', 'uniform-pdf', false, 20000000, array['application/pdf'])
on conflict (id) do update set public = false;
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('uniform-erp', 'uniform-erp', false, 20000000, array['text/plain', 'text/csv', 'application/octet-stream'])
on conflict (id) do update set public = false;
grant select, insert on table storage.objects to job_document_renderer, job_erp_renderer;
revoke update, delete, truncate on table storage.objects from job_document_renderer, job_erp_renderer;
drop policy if exists uniform_pdf_renderer_select on storage.objects;
create policy uniform_pdf_renderer_select on storage.objects for select to job_document_renderer using (bucket_id = 'uniform-pdf');
create policy uniform_pdf_renderer_insert on storage.objects for insert to job_document_renderer with check (bucket_id = 'uniform-pdf');
drop policy if exists uniform_pdf_ready_read on storage.objects;
create policy uniform_pdf_ready_read on storage.objects for select to authenticated using (
  bucket_id = 'uniform-pdf' and exists (
    select 1 from public.document_artifacts a
    join public.document_artifact_families f on f.id = a.family_id
    where a.status = 'READY'
      and a.storage_object_key = name
      and ((f.document_type = 'HR_REQUEST' and private.has_role('HR'))
        or (f.document_type = 'STOCKTAKE' and (private.has_role('HR') or private.has_role('WAREHOUSE')))
        or (f.document_type = 'RETURN_NOTE' and private.has_role('HR')))
  )
);
drop policy if exists uniform_erp_renderer_select on storage.objects;
create policy uniform_erp_renderer_select on storage.objects for select to job_erp_renderer using (bucket_id = 'uniform-erp');
create policy uniform_erp_renderer_insert on storage.objects for insert to job_erp_renderer with check (bucket_id = 'uniform-erp');
drop policy if exists uniform_erp_ready_read on storage.objects;
create policy uniform_erp_ready_read on storage.objects for select to authenticated using (
      bucket_id = 'uniform-erp' and exists (
    select 1 from public.erp_export_artifacts a
    join public.erp_export_batches b on b.id = a.batch_id
    where a.status = 'READY'
      and a.storage_object_key = name and (private.has_role('HR') or private.has_role('WAREHOUSE'))
  )
);

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

-- Fixed public signatures are intentionally symmetric.  Claim/heartbeat/
-- retry/fail/finalize are job-only; status/download are authenticated RPCs.
create or replace function public.claim_document_render_attempt(p_lease_seconds integer)
returns public.document_render_attempts language plpgsql security definer set search_path = pg_catalog, private as $$
declare r public.document_render_attempts; a public.document_artifact_families; x public.document_artifacts;
begin
  perform private.require_document_renderer();
  if p_lease_seconds is null or p_lease_seconds not between 30 and 900 then raise exception 'invalid lease' using errcode='22023'; end if;
  for a in select f.* from public.document_artifact_families f where f.active_artifact_id is not null and exists (select 1 from public.document_artifacts da join public.document_render_attempts dt on dt.artifact_id=da.id where da.id=f.active_artifact_id and da.status='PREPARING' and (dt.status='PENDING' or (dt.status='RENDERING' and dt.lease_expires_at<=transaction_timestamp()))) order by f.id for update skip locked loop
    select * into x from public.document_artifacts where id=a.active_artifact_id and status='PREPARING' for update;
    if not found then continue; end if;
    select * into r from public.document_render_attempts where artifact_id=x.id and (status='PENDING' or (status='RENDERING' and lease_expires_at<=transaction_timestamp())) order by attempt_no for update skip locked limit 1;
    if not found then continue; end if;
    update public.document_render_attempts set status='RENDERING', lease_token=encode(gen_random_bytes(24),'hex'), lease_generation=r.lease_generation+1, lease_expires_at=transaction_timestamp()+make_interval(secs=>p_lease_seconds), temp_object_key=coalesce(r.temp_object_key,'pdf/'||r.id::text), started_at=coalesce(started_at,now()), failed_at=null, error_code=null, error_message=null where id=r.id returning * into r;
    return r;
  end loop;
  return null;
end; $$;
create or replace function public.heartbeat_document_render_attempt(p_attempt_id uuid, p_lease_token text, p_lease_generation bigint, p_lease_seconds integer)
returns public.document_render_attempts language plpgsql security definer set search_path = pg_catalog, private as $$
declare r public.document_render_attempts;
begin
  perform private.require_document_renderer();
  if p_lease_seconds is null or p_lease_seconds not between 30 and 900 then raise exception 'invalid lease' using errcode='22023'; end if;
  update public.document_render_attempts set lease_expires_at=transaction_timestamp()+make_interval(secs=>p_lease_seconds) where id=p_attempt_id and status='RENDERING' and lease_token=p_lease_token and lease_generation=p_lease_generation and lease_expires_at>transaction_timestamp() returning * into r;
  if not found then raise exception 'stale renderer lease' using errcode='40001'; end if;
  return r;
end; $$;
create or replace function public.retry_document_render_attempt(p_attempt_id uuid, p_lease_token text, p_lease_generation bigint, p_error_code text, p_error_message text)
returns public.document_render_attempts language plpgsql security definer set search_path = pg_catalog, private as $$
declare r public.document_render_attempts; x public.document_artifacts; f public.document_artifact_families; nr public.document_render_attempts;
begin
  perform private.require_document_renderer();
  select artifact_id into strict x.id from public.document_render_attempts where id=p_attempt_id;
  select family_id into strict x.family_id from public.document_artifacts where id=x.id;
  select * into strict f from public.document_artifact_families where id=x.family_id for update;
  select * into strict x from public.document_artifacts where id=x.id for update;
  select * into strict r from public.document_render_attempts where id=p_attempt_id for update;
  if f.active_artifact_id is distinct from x.id or x.status<>'PREPARING' or r.status<>'RENDERING' or r.lease_token<>p_lease_token or r.lease_generation<>p_lease_generation or r.lease_expires_at<=transaction_timestamp() then raise exception 'stale document render attempt' using errcode='40001'; end if;
  update public.document_render_attempts set status='FAILED',failed_at=now(),lease_expires_at=null,error_code=left(coalesce(p_error_code,'RENDER_FAILED'),80),error_message=left(coalesce(p_error_message,'renderer failed'),500) where id=r.id;
  if (select count(*) from public.document_render_attempts where artifact_id=x.id) >= x.max_attempts then
    update public.document_artifacts set status='FAILED',failed_at=now(),error_code='RENDER_ATTEMPTS_EXHAUSTED',error_message='renderer attempt limit reached' where id=x.id;
    update public.document_artifact_families set active_artifact_id=null where id=f.id;
    select * into r from public.document_render_attempts where id=r.id; return r;
  end if;
  insert into public.document_render_attempts(artifact_id,attempt_no,attempt_key) select x.id,coalesce(max(attempt_no),0)+1,x.id::text||':attempt:'||(coalesce(max(attempt_no),0)+1)::text||':'||gen_random_uuid()::text from public.document_render_attempts where artifact_id=x.id returning * into nr;
  return nr;
end; $$;
create or replace function public.fail_document_render_attempt(p_attempt_id uuid, p_lease_token text, p_lease_generation bigint, p_error_code text, p_error_message text)
returns public.document_render_attempts language plpgsql security definer set search_path = pg_catalog, private as $$
declare r public.document_render_attempts; x public.document_artifacts; f public.document_artifact_families;
begin
  perform private.require_document_renderer();
  select artifact_id into strict x.id from public.document_render_attempts where id=p_attempt_id;
  select family_id into strict x.family_id from public.document_artifacts where id=x.id;
  select * into strict f from public.document_artifact_families where id=x.family_id for update;
  select * into strict x from public.document_artifacts where id=x.id for update;
  select * into strict r from public.document_render_attempts where id=p_attempt_id for update;
  if f.active_artifact_id is distinct from x.id or x.status<>'PREPARING' or r.status<>'RENDERING' or r.lease_token<>p_lease_token or r.lease_generation<>p_lease_generation or r.lease_expires_at<=transaction_timestamp() then raise exception 'stale document render attempt' using errcode='40001'; end if;
  update public.document_render_attempts set status='FAILED',failed_at=now(),lease_expires_at=null,error_code=left(coalesce(p_error_code,'RENDER_FAILED'),80),error_message=left(coalesce(p_error_message,'renderer failed'),500) where id=r.id;
  update public.document_artifacts set status='FAILED',failed_at=now(),error_code=left(coalesce(p_error_code,'RENDER_FAILED'),80),error_message=left(coalesce(p_error_message,'renderer failed'),500) where id=x.id;
  update public.document_artifact_families set active_artifact_id=null where id=f.id;
  select * into r from public.document_render_attempts where id=r.id; return r;
end; $$;
create or replace function public.finalize_document_render_attempt(p_attempt_id uuid, p_lease_token text, p_lease_generation bigint, p_temp_object_key text, p_payload_sha256 text, p_payload_size_bytes bigint)
returns public.document_artifacts language plpgsql security definer set search_path = pg_catalog, private as $$
declare r public.document_render_attempts; x public.document_artifacts; f public.document_artifact_families; h text; n bigint;
begin
  perform private.require_document_renderer();
  if p_payload_sha256 is null or p_payload_sha256 !~ '^[0-9a-fA-F]{64}$' or p_payload_size_bytes is null or p_payload_size_bytes <= 0 or p_payload_size_bytes > 20000000 then raise exception 'invalid document payload metadata' using errcode='22023'; end if;
  select artifact_id into strict x.id from public.document_render_attempts where id=p_attempt_id;
  select family_id into strict x.family_id from public.document_artifacts where id=x.id;
  select * into strict f from public.document_artifact_families where id=x.family_id for update;
  select * into strict x from public.document_artifacts where id=x.id for update;
  select * into strict r from public.document_render_attempts where id=p_attempt_id for update;
  if x.status='READY' and x.winning_attempt_id=r.id and x.storage_object_key=p_temp_object_key and x.payload_sha256=lower(p_payload_sha256) then return x; end if;
  if f.active_artifact_id is distinct from x.id or x.status<>'PREPARING' or r.status<>'RENDERING' or r.temp_object_key is distinct from p_temp_object_key or r.lease_token<>p_lease_token or r.lease_generation<>p_lease_generation or r.lease_expires_at<=transaction_timestamp() then raise exception 'stale document render attempt' using errcode='40001'; end if;
  select lower(coalesce(metadata->>'sha256', user_metadata->>'sha256','')), case when coalesce(metadata->>'size', user_metadata->>'size') ~ '^[0-9]+$' then coalesce(metadata->>'size', user_metadata->>'size')::bigint end into h,n from storage.objects where bucket_id='uniform-pdf' and name=p_temp_object_key;
  if not found or h<>lower(p_payload_sha256) or n<>p_payload_size_bytes then raise exception 'document object metadata mismatch' using errcode='P0001'; end if;
  update public.document_artifacts set is_current=false where family_id=x.family_id and is_current;
  update public.document_render_attempts set status='SUCCEEDED',temp_object_key=p_temp_object_key,payload_sha256=lower(p_payload_sha256),payload_size_bytes=p_payload_size_bytes,uploaded_at=coalesce(uploaded_at,now()),succeeded_at=now(),lease_expires_at=null where id=r.id;
  update public.document_artifacts set status='READY',storage_object_key=p_temp_object_key,payload_sha256=lower(p_payload_sha256),payload_size_bytes=p_payload_size_bytes,winning_attempt_id=r.id,ready_at=now(),is_current=true where id=x.id;
  update public.document_artifact_families set current_artifact_id=x.id,active_artifact_id=null where id=f.id;
  select * into x from public.document_artifacts where id=x.id; return x;
end; $$;

create or replace function public.claim_erp_render_attempt(p_lease_seconds integer)
returns public.erp_export_render_attempts language plpgsql security definer set search_path = pg_catalog, private as $$
declare r public.erp_export_render_attempts; b public.erp_export_batches; x public.erp_export_artifacts;
begin
  perform private.require_erp_renderer();
  if p_lease_seconds is null or p_lease_seconds not between 30 and 900 then raise exception 'invalid lease' using errcode='22023'; end if;
  for b in select q.* from public.erp_export_batches q where q.active_artifact_id is not null and exists (select 1 from public.erp_export_artifacts ea join public.erp_export_render_attempts et on et.artifact_id=ea.id where ea.id=q.active_artifact_id and ea.status='PREPARING' and (et.status='PENDING' or (et.status='RENDERING' and et.lease_expires_at<=transaction_timestamp()))) order by q.id for update skip locked loop
    select * into x from public.erp_export_artifacts where id=b.active_artifact_id and status='PREPARING' for update;
    if not found then continue; end if;
    select * into r from public.erp_export_render_attempts where artifact_id=x.id and (status='PENDING' or (status='RENDERING' and lease_expires_at<=transaction_timestamp())) order by attempt_no for update skip locked limit 1;
    if not found then continue; end if;
    update public.erp_export_render_attempts set status='RENDERING', lease_token=encode(gen_random_bytes(24),'hex'), lease_generation=r.lease_generation+1, lease_expires_at=transaction_timestamp()+make_interval(secs=>p_lease_seconds), temp_object_key=coalesce(r.temp_object_key,'erp/'||r.id::text), started_at=coalesce(started_at,now()), failed_at=null, error_code=null, error_message=null where id=r.id returning * into r;
    return r;
  end loop;
  return null;
end; $$;
create or replace function public.heartbeat_erp_render_attempt(p_attempt_id uuid, p_lease_token text, p_lease_generation bigint, p_lease_seconds integer)
returns public.erp_export_render_attempts language plpgsql security definer set search_path = pg_catalog, private as $$
declare r public.erp_export_render_attempts;
begin
  perform private.require_erp_renderer();
  if p_lease_seconds is null or p_lease_seconds not between 30 and 900 then raise exception 'invalid lease' using errcode='22023'; end if;
  update public.erp_export_render_attempts set lease_expires_at=transaction_timestamp()+make_interval(secs=>p_lease_seconds) where id=p_attempt_id and status='RENDERING' and lease_token=p_lease_token and lease_generation=p_lease_generation and lease_expires_at>transaction_timestamp() returning * into r;
  if not found then raise exception 'stale renderer lease' using errcode='40001'; end if;
  return r;
end; $$;
create or replace function public.retry_erp_render_attempt(p_attempt_id uuid, p_lease_token text, p_lease_generation bigint, p_error_code text, p_error_message text)
returns public.erp_export_render_attempts language plpgsql security definer set search_path = pg_catalog, private as $$
declare r public.erp_export_render_attempts; x public.erp_export_artifacts; b public.erp_export_batches; nr public.erp_export_render_attempts;
begin
  perform private.require_erp_renderer();
  select artifact_id into strict x.id from public.erp_export_render_attempts where id=p_attempt_id;
  select batch_id into strict x.batch_id from public.erp_export_artifacts where id=x.id;
  select * into strict b from public.erp_export_batches where id=x.batch_id for update;
  select * into strict x from public.erp_export_artifacts where id=x.id for update;
  select * into strict r from public.erp_export_render_attempts where id=p_attempt_id for update;
  if b.active_artifact_id is distinct from x.id or x.status<>'PREPARING' or r.status<>'RENDERING' or r.lease_token<>p_lease_token or r.lease_generation<>p_lease_generation or r.lease_expires_at<=transaction_timestamp() then raise exception 'stale ERP render attempt' using errcode='40001'; end if;
  update public.erp_export_render_attempts set status='FAILED',failed_at=now(),lease_expires_at=null,error_code=left(coalesce(p_error_code,'RENDER_FAILED'),80),error_message=left(coalesce(p_error_message,'renderer failed'),500) where id=r.id;
  if (select count(*) from public.erp_export_render_attempts where artifact_id=x.id) >= x.max_attempts then
    update public.erp_export_artifacts set status='FAILED',failed_at=now(),error_code='RENDER_ATTEMPTS_EXHAUSTED',error_message='renderer attempt limit reached' where id=x.id;
    update public.erp_export_batches set status='GENERATION_FAILED',active_artifact_id=null,last_error_code='RENDER_ATTEMPTS_EXHAUSTED',last_error_message='renderer attempt limit reached' where id=b.id;
    select * into r from public.erp_export_render_attempts where id=r.id; return r;
  end if;
  insert into public.erp_export_render_attempts(artifact_id,attempt_no,attempt_key) select x.id,coalesce(max(attempt_no),0)+1,x.id::text||':attempt:'||(coalesce(max(attempt_no),0)+1)::text||':'||gen_random_uuid()::text from public.erp_export_render_attempts where artifact_id=x.id returning * into nr;
  return nr;
end; $$;
create or replace function public.fail_erp_render_attempt(p_attempt_id uuid, p_lease_token text, p_lease_generation bigint, p_error_code text, p_error_message text)
returns public.erp_export_render_attempts language plpgsql security definer set search_path = pg_catalog, private as $$
declare r public.erp_export_render_attempts; x public.erp_export_artifacts; b public.erp_export_batches;
begin
  perform private.require_erp_renderer();
  select artifact_id into strict x.id from public.erp_export_render_attempts where id=p_attempt_id;
  select batch_id into strict x.batch_id from public.erp_export_artifacts where id=x.id;
  select * into strict b from public.erp_export_batches where id=x.batch_id for update;
  select * into strict x from public.erp_export_artifacts where id=x.id for update;
  select * into strict r from public.erp_export_render_attempts where id=p_attempt_id for update;
  if b.active_artifact_id is distinct from x.id or x.status<>'PREPARING' or r.status<>'RENDERING' or r.lease_token<>p_lease_token or r.lease_generation<>p_lease_generation or r.lease_expires_at<=transaction_timestamp() then raise exception 'stale ERP render attempt' using errcode='40001'; end if;
  update public.erp_export_render_attempts set status='FAILED',failed_at=now(),lease_expires_at=null,error_code=left(coalesce(p_error_code,'RENDER_FAILED'),80),error_message=left(coalesce(p_error_message,'renderer failed'),500) where id=r.id;
  update public.erp_export_artifacts set status='FAILED',failed_at=now(),error_code=left(coalesce(p_error_code,'RENDER_FAILED'),80),error_message=left(coalesce(p_error_message,'renderer failed'),500) where id=x.id;
  update public.erp_export_batches set status='GENERATION_FAILED',active_artifact_id=null,last_error_code=left(coalesce(p_error_code,'RENDER_FAILED'),80),last_error_message=left(coalesce(p_error_message,'renderer failed'),500) where id=b.id;
  select * into r from public.erp_export_render_attempts where id=r.id; return r;
end; $$;
create or replace function public.finalize_erp_render_attempt(p_attempt_id uuid, p_lease_token text, p_lease_generation bigint, p_temp_object_key text, p_payload_sha256 text, p_payload_size_bytes bigint)
returns public.erp_export_artifacts language plpgsql security definer set search_path = pg_catalog, private as $$
declare r public.erp_export_render_attempts; x public.erp_export_artifacts; b public.erp_export_batches; h text; n bigint; actor_id uuid;
begin
  actor_id := private.require_erp_renderer();
  if p_payload_sha256 is null or p_payload_sha256 !~ '^[0-9a-fA-F]{64}$' or p_payload_size_bytes is null or p_payload_size_bytes <= 0 or p_payload_size_bytes > 20000000 then raise exception 'invalid ERP payload metadata' using errcode='22023'; end if;
  select artifact_id into strict x.id from public.erp_export_render_attempts where id=p_attempt_id;
  select batch_id into strict x.batch_id from public.erp_export_artifacts where id=x.id;
  select * into strict b from public.erp_export_batches where id=x.batch_id for update;
  select * into strict x from public.erp_export_artifacts where id=x.id for update;
  select * into strict r from public.erp_export_render_attempts where id=p_attempt_id for update;
  if x.status='READY' and x.winning_attempt_id=r.id and x.storage_object_key=p_temp_object_key and x.payload_sha256=lower(p_payload_sha256) then return x; end if;
  if b.active_artifact_id is distinct from x.id or x.status<>'PREPARING' or r.status<>'RENDERING' or r.temp_object_key is distinct from p_temp_object_key or r.lease_token<>p_lease_token or r.lease_generation<>p_lease_generation or r.lease_expires_at<=transaction_timestamp() then raise exception 'stale ERP render attempt' using errcode='40001'; end if;
  select lower(coalesce(metadata->>'sha256', user_metadata->>'sha256','')), case when coalesce(metadata->>'size', user_metadata->>'size') ~ '^[0-9]+$' then coalesce(metadata->>'size', user_metadata->>'size')::bigint end into h,n from storage.objects where bucket_id='uniform-erp' and name=p_temp_object_key;
  if not found or h<>lower(p_payload_sha256) or n<>p_payload_size_bytes then raise exception 'ERP object metadata mismatch' using errcode='P0001'; end if;
  update public.erp_export_artifacts set is_current=false where batch_id=x.batch_id and is_current;
  update public.erp_export_render_attempts set status='SUCCEEDED',temp_object_key=p_temp_object_key,payload_sha256=lower(p_payload_sha256),payload_size_bytes=p_payload_size_bytes,uploaded_at=coalesce(uploaded_at,now()),succeeded_at=now(),lease_expires_at=null where id=r.id;
  update public.erp_export_artifacts set status='READY',storage_object_key=p_temp_object_key,payload_sha256=lower(p_payload_sha256),payload_size_bytes=p_payload_size_bytes,winning_attempt_id=r.id,ready_at=now(),is_current=true where id=x.id;
  update public.erp_export_batches set status='GENERATED',current_artifact_id=x.id,active_artifact_id=null,generated_at=now(),generated_by=actor_id,last_error_code=null,last_error_message=null where id=b.id;
  select * into x from public.erp_export_artifacts where id=x.id; return x;
end; $$;

create or replace function public.get_document_render_payload(p_attempt_id uuid, p_lease_token text, p_lease_generation bigint)
returns jsonb language plpgsql security definer set search_path = pg_catalog, private as $$
declare r public.document_render_attempts; a public.document_artifacts; f public.document_artifact_families; header jsonb; lines jsonb; snapshot jsonb;
begin
  perform private.require_document_renderer();
  select * into strict r from public.document_render_attempts where id=p_attempt_id and status='RENDERING' and lease_token=p_lease_token and lease_generation=p_lease_generation and lease_expires_at>transaction_timestamp();
  select * into strict a from public.document_artifacts where id=r.artifact_id and status='PREPARING';
  select * into strict f from public.document_artifact_families where id=a.family_id and active_artifact_id=a.id;
  if f.document_type = 'HR_REQUEST' then
    select jsonb_build_object('id',q.id,'request_no',q.request_no,'status',q.status,'distribution_date',q.distribution_date,'note',q.note,'row_version',q.row_version) into header from public.hr_requests q where q.id=f.document_id;
    select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'line_no',l.line_no,'employee_id',l.employee_id,'item_id',l.item_id,'quantity',l.quantity,'employee_no',l.employee_no_snapshot,'employee_name',l.employee_name_snapshot,'institution_id',l.institution_id_snapshot,'institution_code',l.institution_code_snapshot,'institution_name',l.institution_name_snapshot,'department_id',l.department_id_snapshot,'department_code',l.department_code_snapshot,'department_name',l.department_name_snapshot,'item_code',l.item_code_snapshot,'item_name',l.item_name_snapshot,'unit',l.unit_snapshot,'size',l.size_snapshot) order by l.line_no),'[]'::jsonb) into lines from public.hr_issue_lines l where l.request_id=f.document_id;
    select jsonb_build_object('header',to_jsonb(q),'lines',coalesce((select jsonb_agg(to_jsonb(l) order by l.line_no) from public.hr_issue_lines l where l.request_id=q.id),'[]'::jsonb)) into snapshot from public.hr_requests q where q.id=f.document_id;
  elsif f.document_type = 'STOCKTAKE' then
    select jsonb_build_object('id',s.id,'stocktake_no',s.stocktake_no,'warehouse_id',s.warehouse_id,'status',s.status,'counted_at',s.counted_at,'note',s.note) into header from public.stocktakes s where s.id=f.document_id;
    select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'item_id',l.item_id,'book_quantity',l.book_quantity_snapshot,'balance_version',l.balance_version_snapshot,'counted_quantity',l.counted_quantity,'difference_quantity',l.difference_quantity,'reason',l.reason) order by l.item_id),'[]'::jsonb) into lines from public.stocktake_lines l where l.stocktake_id=f.document_id;
    select jsonb_build_object('header',to_jsonb(s),'lines',coalesce((select jsonb_agg(to_jsonb(l) order by l.item_id) from public.stocktake_lines l where l.stocktake_id=s.id),'[]'::jsonb)) into snapshot from public.stocktakes s where s.id=f.document_id;
  elsif f.document_type = 'RETURN_NOTE' then
    select jsonb_build_object('id',n.id,'return_no',n.return_no,'original_hr_request_id',n.original_hr_request_id,'status',n.status,'reason',n.reason,'note',n.note) into header from public.return_notes n where n.id=f.document_id;
    select coalesce(jsonb_agg(jsonb_build_object('id',l.id,'line_no',l.line_no,'original_issue_line_id',l.original_issue_line_id,'employee_id',l.employee_id,'item_id',l.item_id,'quantity',l.quantity,'employee_no',l.employee_no_snapshot,'employee_name',l.employee_name_snapshot,'item_code',l.item_code_snapshot,'item_name',l.item_name_snapshot,'size',l.size_snapshot,'unit',l.unit_snapshot) order by l.line_no),'[]'::jsonb) into lines from public.return_lines l where l.return_note_id=f.document_id;
    select jsonb_build_object('header',to_jsonb(n),'lines',coalesce((select jsonb_agg(to_jsonb(l) order by l.line_no) from public.return_lines l where l.return_note_id=n.id),'[]'::jsonb)) into snapshot from public.return_notes n where n.id=f.document_id;
  end if;
  if header is null or lines is null or snapshot is null then raise exception 'Document render source is unavailable'; end if;
  if md5(snapshot::text) is distinct from a.source_snapshot_hash or md5(snapshot::text) is distinct from f.source_snapshot_hash then raise exception 'Document render source snapshot changed' using errcode='40001'; end if;
  return jsonb_build_object('schema','uniform-document-render-payload-v1','document_type',f.document_type,'document_id',f.document_id,'artifact_id',a.id,'artifact_kind',f.artifact_kind,'revision',a.revision,'template_version',a.template_version,'source_snapshot_version',a.source_snapshot_version,'source_snapshot_hash',a.source_snapshot_hash,'header',header,'lines',lines,'canonical_snapshot',snapshot);
end; $$;
create or replace function public.get_erp_render_payload(p_attempt_id uuid, p_lease_token text, p_lease_generation bigint)
returns jsonb language plpgsql security definer set search_path = pg_catalog, private as $$
declare r public.erp_export_render_attempts; a public.erp_export_artifacts; b public.erp_export_batches; lines jsonb; batch_snapshot jsonb; computed_hash text;
begin
  perform private.require_erp_renderer();
  select * into strict r from public.erp_export_render_attempts where id=p_attempt_id and status='RENDERING' and lease_token=p_lease_token and lease_generation=p_lease_generation and lease_expires_at>transaction_timestamp();
  select * into strict a from public.erp_export_artifacts where id=r.artifact_id and status='PREPARING';
  select * into strict b from public.erp_export_batches where id=a.batch_id and active_artifact_id=a.id;
  select coalesce(jsonb_agg(jsonb_build_object('line_no',l.line_no,'item_id',l.item_id,'item_code',l.item_code_snapshot,'item_name',l.item_name_snapshot,'unit',l.unit_snapshot,'quantity',l.quantity) order by l.line_no),'[]'::jsonb) into lines from public.erp_export_batch_lines l where l.batch_id=b.id;
  batch_snapshot := jsonb_build_object('batch_no',b.batch_no,'export_kind',b.export_kind,'distribution_date',b.distribution_date,'institution_id',b.institution_id_snapshot,'institution_code',b.institution_code_snapshot,'institution_name',b.institution_name_snapshot,'source_snapshot_version',b.source_snapshot_version,'source_snapshot_hash',b.source_snapshot_hash);
  select md5(coalesce(string_agg(format('%s:%s:%s', l.id, l.item_id, l.quantity), '| ' order by l.id), '')) into computed_hash
    from public.erp_export_source_links sl join public.hr_issue_lines l on l.id=sl.issue_line_id where sl.batch_id=b.id and sl.issue_line_id is not null;
  if computed_hash is distinct from a.source_snapshot_hash or computed_hash is distinct from b.source_snapshot_hash then raise exception 'ERP render source snapshot changed' using errcode='40001'; end if;
  return jsonb_build_object('schema','uniform-erp-render-payload-v1','artifact_id',a.id,'batch_id',b.id,'format_version',a.format_version,'source_snapshot_version',a.source_snapshot_version,'source_snapshot_hash',a.source_snapshot_hash,'batch',batch_snapshot,'lines',lines);
end; $$;
revoke all on function public.get_document_render_payload(uuid,text,bigint), public.get_erp_render_payload(uuid,text,bigint) from public, anon, authenticated;

create or replace function public.get_document_status(p_artifact_id uuid, p_idempotency_key text default null)
returns public.document_artifacts language plpgsql security definer set search_path = pg_catalog, private as $$
declare r public.document_artifacts; aid uuid;
begin
  if auth.uid() is null or coalesce(auth.jwt()->>'role','')<>'authenticated' or private.current_account_id() is null then raise exception using errcode='42501'; end if;
  aid := p_artifact_id;
  if aid is null and btrim(coalesce(p_idempotency_key,''))<>'' then select result_entity_id into aid from public.operation_commands where operation_code='REQUEST_DOCUMENT_PDF' and idempotency_key=p_idempotency_key and actor_account_id=private.current_account_id(); end if;
  select a.* into r from public.document_artifacts a where a.id=aid and (private.has_role('HR') or private.has_role('WAREHOUSE') or private.has_role('PROCUREMENT') or private.has_role('CEO'));
  return r;
end; $$;
create or replace function public.download_document(p_artifact_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, private as $$
declare r public.document_artifacts; f public.document_artifact_families; aid uuid;
begin
  aid := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt()->>'role','')<>'authenticated' or aid is null then raise exception using errcode='42501'; end if;
  select * into r from public.document_artifacts where id=p_artifact_id;
  select * into f from public.document_artifact_families where id=r.family_id;
  if r.id is null or r.status<>'READY' then raise exception 'document is not downloadable' using errcode='55000'; end if;
  if not ((f.document_type='HR_REQUEST' and private.has_role('HR')) or (f.document_type='STOCKTAKE' and (private.has_role('HR') or private.has_role('WAREHOUSE'))) or (f.document_type='RETURN_NOTE' and private.has_role('HR'))) then raise exception using errcode='42501'; end if;
  perform private.append_audit_event(aid,'DOCUMENT_DOWNLOAD_REQUESTED','document_artifacts',r.id,null,to_jsonb(r),null,null,null,jsonb_build_object('bucket','uniform-pdf'));
  return jsonb_build_object('bucket','uniform-pdf','object_key',r.storage_object_key,'sha256',r.payload_sha256,'size_bytes',r.payload_size_bytes,'revision',r.revision);
end; $$;
create or replace function public.get_erp_artifact_status(p_artifact_id uuid, p_idempotency_key text default null)
returns public.erp_export_artifacts language plpgsql security definer set search_path = pg_catalog, private as $$
declare r public.erp_export_artifacts; aid uuid;
begin
  if auth.uid() is null or coalesce(auth.jwt()->>'role','')<>'authenticated' or private.current_account_id() is null then raise exception using errcode='42501'; end if;
  aid:=p_artifact_id;
  if aid is null and btrim(coalesce(p_idempotency_key,''))<>'' then select result_entity_id into aid from public.operation_commands where operation_code='REQUEST_ERP_ARTIFACT' and idempotency_key=p_idempotency_key and actor_account_id=private.current_account_id(); end if;
  select a.* into r from public.erp_export_artifacts a where a.id=aid and (private.has_role('HR') or private.has_role('WAREHOUSE')); return r;
end; $$;
create or replace function public.get_erp_batch_status(p_batch_id uuid default null, p_idempotency_key text default null)
returns public.erp_export_batches language plpgsql security definer set search_path = pg_catalog, private as $$
declare r public.erp_export_batches; bid uuid;
begin
  if auth.uid() is null or coalesce(auth.jwt()->>'role','')<>'authenticated' or private.current_account_id() is null or not private.has_role('HR') then raise exception using errcode='42501'; end if;
  bid := p_batch_id;
  if bid is null and btrim(coalesce(p_idempotency_key,''))<>'' then
    select result_entity_id into bid from public.operation_commands where operation_code='CREATE_ERP_EXPORT_BATCH' and idempotency_key=p_idempotency_key and actor_account_id=private.current_account_id();
  end if;
  select b.* into r from public.erp_export_batches b where b.id=bid and b.prepared_by=private.current_account_id();
  return r;
end; $$;
create or replace function public.download_erp_artifact(p_batch_id uuid, p_artifact_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, private as $$
declare b public.erp_export_batches; r public.erp_export_artifacts; aid uuid;
begin
  aid:=private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt()->>'role','')<>'authenticated' or aid is null or not (private.has_role('HR') or private.has_role('WAREHOUSE')) then raise exception using errcode='42501'; end if;
  select * into b from public.erp_export_batches where id=p_batch_id for update;
  select * into r from public.erp_export_artifacts where id=p_artifact_id and batch_id=p_batch_id;
  if b.id is null or r.id is null or r.status<>'READY' or b.status not in ('GENERATED','DOWNLOADED','IMPORT_FAILED','IMPORT_CONFIRMED') then raise exception 'ERP artifact is not downloadable' using errcode='55000'; end if;
  insert into public.erp_export_download_events(batch_id,artifact_id,downloaded_by) values (b.id,r.id,aid);
  update public.erp_export_batches set status=case when status='GENERATED' then 'DOWNLOADED' else status end,downloaded_at=coalesce(downloaded_at,now()) where id=b.id;
  return jsonb_build_object('bucket','uniform-erp','object_key',r.storage_object_key,'sha256',r.payload_sha256,'size_bytes',r.payload_size_bytes,'revision',r.revision,'batch_id',b.id);
end; $$;

revoke all on function public.claim_document_render_attempt(integer), public.heartbeat_document_render_attempt(uuid,text,bigint,integer), public.retry_document_render_attempt(uuid,text,bigint,text,text), public.fail_document_render_attempt(uuid,text,bigint,text,text), public.finalize_document_render_attempt(uuid,text,bigint,text,text,bigint) from public, anon, authenticated;
grant execute on function public.claim_document_render_attempt(integer), public.heartbeat_document_render_attempt(uuid,text,bigint,integer), public.retry_document_render_attempt(uuid,text,bigint,text,text), public.fail_document_render_attempt(uuid,text,bigint,text,text), public.finalize_document_render_attempt(uuid,text,bigint,text,text,bigint) to job_document_renderer;
revoke all on function public.claim_erp_render_attempt(integer), public.heartbeat_erp_render_attempt(uuid,text,bigint,integer), public.retry_erp_render_attempt(uuid,text,bigint,text,text), public.fail_erp_render_attempt(uuid,text,bigint,text,text), public.finalize_erp_render_attempt(uuid,text,bigint,text,text,bigint) from public, anon, authenticated;
grant execute on function public.claim_erp_render_attempt(integer), public.heartbeat_erp_render_attempt(uuid,text,bigint,integer), public.retry_erp_render_attempt(uuid,text,bigint,text,text), public.fail_erp_render_attempt(uuid,text,bigint,text,text), public.finalize_erp_render_attempt(uuid,text,bigint,text,text,bigint) to job_erp_renderer;
grant execute on function public.get_document_render_payload(uuid,text,bigint) to job_document_renderer;
grant execute on function public.get_erp_render_payload(uuid,text,bigint) to job_erp_renderer;
revoke all on function public.get_document_status(uuid,text), public.download_document(uuid), public.get_erp_artifact_status(uuid,text), public.get_erp_batch_status(uuid,text), public.download_erp_artifact(uuid,uuid) from public, anon;
grant execute on function public.get_document_status(uuid,text), public.download_document(uuid), public.get_erp_artifact_status(uuid,text), public.get_erp_batch_status(uuid,text), public.download_erp_artifact(uuid,uuid) to authenticated;
