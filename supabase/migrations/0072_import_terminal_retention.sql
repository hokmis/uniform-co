-- Durable import terminal-retention timestamp and Storage eligibility.
--
-- FAILED/CANCELLED batches keep their database evidence. This migration only
-- gives their source object a reliable 90-day retention clock and extends the
-- existing DB-authoritative Storage cleanup contract.

alter table public.import_batches
  add column terminal_at timestamptz;

create or replace function private.set_import_terminal_at()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  if new.status in ('FAILED', 'CANCELLED') then
    if tg_op = 'INSERT' then
      new.terminal_at := transaction_timestamp();
    elsif old.status not in ('FAILED', 'CANCELLED') then
      new.terminal_at := transaction_timestamp();
    else
      -- Metadata updates while a batch remains terminal must not move the
      -- retention clock. Ignore any attempted terminal_at rewrite.
      new.terminal_at := old.terminal_at;
    end if;
  else
    -- A controlled restart from FAILED begins a fresh terminal-retention
    -- episode only if the batch later becomes terminal again.
    new.terminal_at := null;
  end if;
  return new;
end;
$$;

-- Existing terminal rows have no trustworthy historical terminal time.
-- Conservatively restart the full 90-day window at migration application.
-- The only existing import_batches trigger blocks updates to CANCELLED rows,
-- so disable that guard only for this bounded backfill inside the migration
-- transaction and restore it immediately afterwards.
alter table public.import_batches disable trigger import_batch_terminal_guard;
update public.import_batches
set terminal_at = transaction_timestamp()
where status in ('FAILED', 'CANCELLED')
  and terminal_at is null;
alter table public.import_batches enable trigger import_batch_terminal_guard;

alter table public.import_batches
  add constraint import_batches_terminal_at_status_check check (
    (status in ('FAILED', 'CANCELLED') and terminal_at is not null)
    or
    (status not in ('FAILED', 'CANCELLED') and terminal_at is null)
  );

create trigger import_batch_terminal_timestamp
before insert or update of status, terminal_at on public.import_batches
for each row execute function private.set_import_terminal_at();

alter table public.storage_cleanup_events
  drop constraint storage_cleanup_events_candidate_type_check;

alter table public.storage_cleanup_events
  add constraint storage_cleanup_events_candidate_type_check check (candidate_type in (
    'UNREFERENCED_OBJECT',
    'EXPIRED_AWAITING_UPLOAD',
    'TERMINAL_IMPORT_90D',
    'FAILED_RENDER_TEMP',
    'EXPIRED_RENDER_LEASE_TEMP'
  ));

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
      if import_row.status in ('FAILED', 'CANCELLED')
         and import_row.terminal_at <= transaction_timestamp() - interval '90 days' then
        return 'TERMINAL_IMPORT_90D';
      end if;
      -- APPLIED and all live states remain retained. The Storage runner only
      -- removes eligible source bytes; import batch/row/diff evidence remains.
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
       'UNREFERENCED_OBJECT', 'EXPIRED_AWAITING_UPLOAD', 'TERMINAL_IMPORT_90D',
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

revoke all on function private.set_import_terminal_at() from public, anon, authenticated;
revoke all on function private.storage_cleanup_candidate_type(text, text) from public, anon, authenticated;
revoke all on function public.record_storage_cleanup_event(text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.record_storage_cleanup_event(text, text, text, text, jsonb) to job_storage_cleanup;
