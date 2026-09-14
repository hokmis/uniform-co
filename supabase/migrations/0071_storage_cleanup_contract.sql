-- Storage orphan/expired-object cleanup contract.
--
-- The database is the only authority that decides whether an object is safe
-- to remove.  This migration never deletes Storage bytes itself and never
-- mutates lease state or business evidence rows.

create table public.storage_cleanup_events (
  id uuid primary key default gen_random_uuid(),
  candidate_type text not null check (candidate_type in (
    'UNREFERENCED_OBJECT',
    'EXPIRED_AWAITING_UPLOAD',
    'FAILED_RENDER_TEMP',
    'EXPIRED_RENDER_LEASE_TEMP'
  )),
  bucket_id text not null check (bucket_id in ('uniform-imports', 'uniform-pdf', 'uniform-erp')),
  object_key text not null check (btrim(object_key) <> ''),
  outcome text not null check (outcome in ('DELETED', 'ALREADY_MISSING', 'FAILED')),
  event_at timestamptz not null default now(),
  event_by uuid not null references public.app_accounts(id),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object')
);

create index storage_cleanup_events_object_idx
  on public.storage_cleanup_events (bucket_id, object_key, event_at desc);

alter table public.storage_cleanup_events enable row level security;
alter table public.storage_cleanup_events force row level security;
revoke all on table public.storage_cleanup_events from public, anon, authenticated, job_storage_cleanup;

create trigger storage_cleanup_events_append_only
before update or delete on public.storage_cleanup_events
for each row execute function private.reject_append_only_mutation();

create or replace function private.require_storage_cleanup_actor()
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  actor_id uuid;
begin
  if session_user <> 'job_storage_cleanup' then
    raise exception using errcode = '42501', message = 'job_storage_cleanup role is required';
  end if;
  actor_id := private.execution_actor_id();
  if actor_id is null then
    raise exception using errcode = '42501', message = 'bound storage cleanup actor is required';
  end if;
  return actor_id;
end;
$$;

create or replace function private.is_storage_cleanup_path_allowed(
  p_bucket_id text,
  p_object_key text
)
returns boolean
language sql
immutable
security definer
set search_path = pg_catalog, private
as $$
  select case p_bucket_id
    when 'uniform-imports' then coalesce(p_object_key, '') ~
      '^imports/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    when 'uniform-pdf' then coalesce(p_object_key, '') ~
      '^pdf/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(/[0-9]+)?$'
    when 'uniform-erp' then coalesce(p_object_key, '') ~
      '^erp/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(/[0-9]+)?$'
    else false
  end
$$;

create or replace function private.storage_cleanup_candidate_type(
  p_bucket_id text,
  p_object_key text
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, private
as $$
declare
  object_timestamp timestamptz;
  import_row public.import_batches;
  document_attempt public.document_render_attempts;
  erp_attempt public.erp_export_render_attempts;
begin
  if not private.is_storage_cleanup_path_allowed(p_bucket_id, p_object_key) then
    return null;
  end if;

  select coalesce(o.updated_at, o.created_at)
    into object_timestamp
    from storage.objects o
    where o.bucket_id = p_bucket_id and o.name = p_object_key;
  if not found or object_timestamp > transaction_timestamp() - interval '24 hours' then
    return null;
  end if;

  if p_bucket_id = 'uniform-imports' then
    select * into import_row
      from public.import_batches b
      where b.storage_bucket = p_bucket_id and b.storage_object_key = p_object_key;
    if found then
      if import_row.status = 'AWAITING_UPLOAD'
         and import_row.upload_expires_at <= transaction_timestamp() then
        return 'EXPIRED_AWAITING_UPLOAD';
      end if;
      -- APPLIED and all live states are retained. FAILED/CANCELLED are also
      -- retained until a reliable terminal-retention timestamp exists.
      return null;
    end if;
    return 'UNREFERENCED_OBJECT';
  end if;

  if p_bucket_id = 'uniform-pdf' then
    if exists (
      select 1 from public.document_artifacts a
      where a.storage_object_key = p_object_key
    ) then
      return null;
    end if;
    select * into document_attempt
      from public.document_render_attempts r
      where r.temp_object_key = p_object_key;
    if found then
      if document_attempt.status = 'FAILED' then
        return 'FAILED_RENDER_TEMP';
      end if;
      if document_attempt.status = 'RENDERING'
         and document_attempt.lease_expires_at <= transaction_timestamp() then
        return 'EXPIRED_RENDER_LEASE_TEMP';
      end if;
      return null;
    end if;
    return 'UNREFERENCED_OBJECT';
  end if;

  if p_bucket_id = 'uniform-erp' then
    if exists (
      select 1 from public.erp_export_artifacts a
      where a.storage_object_key = p_object_key
    ) then
      return null;
    end if;
    select * into erp_attempt
      from public.erp_export_render_attempts r
      where r.temp_object_key = p_object_key;
    if found then
      if erp_attempt.status = 'FAILED' then
        return 'FAILED_RENDER_TEMP';
      end if;
      if erp_attempt.status = 'RENDERING'
         and erp_attempt.lease_expires_at <= transaction_timestamp() then
        return 'EXPIRED_RENDER_LEASE_TEMP';
      end if;
      return null;
    end if;
    return 'UNREFERENCED_OBJECT';
  end if;

  return null;
end;
$$;

create or replace function public.list_storage_cleanup_candidates(p_limit integer default 100)
returns table (
  candidate_type text,
  bucket_id text,
  object_key text,
  object_updated_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  actor_id uuid;
begin
  actor_id := private.require_storage_cleanup_actor();
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'Storage cleanup candidate limit is invalid' using errcode = '22023';
  end if;

  return query
  select
    private.storage_cleanup_candidate_type(o.bucket_id, o.name),
    o.bucket_id,
    o.name,
    coalesce(o.updated_at, o.created_at)
  from storage.objects o
  where o.bucket_id in ('uniform-imports', 'uniform-pdf', 'uniform-erp')
    and coalesce(o.updated_at, o.created_at) <= transaction_timestamp() - interval '24 hours'
    and private.storage_cleanup_candidate_type(o.bucket_id, o.name) is not null
  order by coalesce(o.updated_at, o.created_at), o.bucket_id, o.name
  limit p_limit;
end;
$$;

create or replace function public.confirm_storage_cleanup_candidate(
  p_bucket_id text,
  p_object_key text
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  actor_id uuid;
begin
  actor_id := private.require_storage_cleanup_actor();
  if not private.is_storage_cleanup_path_allowed(p_bucket_id, p_object_key) then
    return null;
  end if;
  perform 1
    from storage.objects o
    where o.bucket_id = p_bucket_id and o.name = p_object_key
    for update;
  if not found then
    return null;
  end if;
  return private.storage_cleanup_candidate_type(p_bucket_id, p_object_key);
end;
$$;

create or replace function public.record_storage_cleanup_event(
  p_candidate_type text,
  p_bucket_id text,
  p_object_key text,
  p_outcome text,
  p_details jsonb default '{}'::jsonb
)
returns public.storage_cleanup_events
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  actor_id uuid;
  event_row public.storage_cleanup_events;
begin
  actor_id := private.require_storage_cleanup_actor();
  if p_candidate_type not in (
       'UNREFERENCED_OBJECT', 'EXPIRED_AWAITING_UPLOAD',
       'FAILED_RENDER_TEMP', 'EXPIRED_RENDER_LEASE_TEMP'
     )
     or p_outcome not in ('DELETED', 'ALREADY_MISSING', 'FAILED')
     or not private.is_storage_cleanup_path_allowed(p_bucket_id, p_object_key)
     or p_details is null or jsonb_typeof(p_details) <> 'object' then
    raise exception 'Invalid storage cleanup event' using errcode = '22023';
  end if;

  insert into public.storage_cleanup_events (
    candidate_type, bucket_id, object_key, outcome, event_by, details
  ) values (
    p_candidate_type, p_bucket_id, p_object_key, p_outcome, actor_id, p_details
  ) returning * into event_row;
  return event_row;
end;
$$;

revoke all on function private.require_storage_cleanup_actor() from public, anon, authenticated;
revoke all on function private.is_storage_cleanup_path_allowed(text, text) from public, anon, authenticated;
revoke all on function private.storage_cleanup_candidate_type(text, text) from public, anon, authenticated;
revoke all on function public.list_storage_cleanup_candidates(integer) from public, anon, authenticated;
revoke all on function public.confirm_storage_cleanup_candidate(text, text) from public, anon, authenticated;
revoke all on function public.record_storage_cleanup_event(text, text, text, text, jsonb) from public, anon, authenticated;

grant execute on function public.list_storage_cleanup_candidates(integer) to job_storage_cleanup;
grant execute on function public.confirm_storage_cleanup_candidate(text, text) to job_storage_cleanup;
grant execute on function public.record_storage_cleanup_event(text, text, text, text, jsonb) to job_storage_cleanup;
