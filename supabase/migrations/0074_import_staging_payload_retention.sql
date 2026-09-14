-- Purge only non-durable import staging payload after a terminal batch has
-- remained FAILED/CANCELLED for 90 days. Durable batch/row/diff evidence stays.

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'job_import_retention') then
    execute 'alter role job_import_retention nologin noinherit';
  else
    execute 'create role job_import_retention noinherit nologin';
  end if;
end;
$$;

alter table public.import_batches
  add column staging_purged_at timestamptz;

alter table public.import_batches
  add constraint import_batches_staging_purged_at_check check (
    staging_purged_at is null
    or (
      status in ('FAILED', 'CANCELLED')
      and terminal_at is not null
      and staging_purged_at >= terminal_at + interval '90 days'
    )
  );

create or replace function private.require_import_retention_actor()
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  actor_id uuid;
begin
  if session_user <> 'job_import_retention' then
    raise exception using errcode = '42501', message = 'job_import_retention role is required';
  end if;
  actor_id := private.execution_actor_id();
  if actor_id is null then
    raise exception using errcode = '42501', message = 'A bound import retention actor is required';
  end if;
  return actor_id;
end;
$$;

-- Keep the original APPLIED/CANCELLED immutability guard, but admit exactly two
-- retention mutations: canonical import_rows payload scrubbing and the batch
-- staging_purged_at marker. No chunk/diff mutation and no metadata rewrite is
-- permitted through this exception.
create or replace function private.prevent_terminal_import_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  retention_status text;
  retention_terminal_at timestamptz;
begin
  if tg_op = 'UPDATE'
     and tg_table_name = 'import_rows'
     and session_user = 'job_import_retention' then
    select b.status, b.terminal_at
      into retention_status, retention_terminal_at
      from public.import_batches b
      where b.id = old.batch_id;

    if retention_status in ('FAILED', 'CANCELLED')
       and retention_terminal_at is not null
       and retention_terminal_at <= transaction_timestamp() - interval '90 days'
       and new.raw_values = '{}'::jsonb
       and new.normalized_values is null
       and new.validation_errors = '[]'::jsonb
       and (to_jsonb(new) - array['raw_values', 'normalized_values', 'validation_errors']::text[])
         = (to_jsonb(old) - array['raw_values', 'normalized_values', 'validation_errors']::text[]) then
      return new;
    end if;
  end if;

  if tg_op = 'UPDATE'
     and tg_table_name = 'import_batches'
     and session_user = 'job_import_retention'
     and old.status in ('FAILED', 'CANCELLED')
     and old.terminal_at is not null
     and old.terminal_at <= transaction_timestamp() - interval '90 days'
     and old.staging_purged_at is null
     and new.staging_purged_at is not null
     and new.staging_purged_at >= old.terminal_at + interval '90 days'
     and (to_jsonb(new) - 'staging_purged_at') = (to_jsonb(old) - 'staging_purged_at') then
    return new;
  end if;

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

-- Once staging payload has been purged, that batch cannot be restarted. A new
-- import batch must be created so a fresh source/payload history is established.
create or replace function private.set_import_terminal_at()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  if tg_op = 'INSERT' then
    if new.staging_purged_at is not null then
      raise exception 'New import batch cannot start with purged staging payload' using errcode = '55000';
    end if;
  else
    if old.staging_purged_at is not null then
      if new.staging_purged_at is distinct from old.staging_purged_at
         or new.status not in ('FAILED', 'CANCELLED') then
        raise exception 'Import batch with purged staging payload is terminal' using errcode = '55000';
      end if;
    elsif new.staging_purged_at is not null then
      if session_user <> 'job_import_retention'
         or old.status not in ('FAILED', 'CANCELLED')
         or old.terminal_at is null
         or old.terminal_at > transaction_timestamp() - interval '90 days'
         or new.status is distinct from old.status then
        raise exception 'Only eligible import retention may mark staging payload purged' using errcode = '55000';
      end if;
    end if;
  end if;

  if new.status in ('FAILED', 'CANCELLED') then
    if tg_op = 'INSERT' then
      new.terminal_at := transaction_timestamp();
    elsif old.status not in ('FAILED', 'CANCELLED') then
      new.terminal_at := transaction_timestamp();
    else
      new.terminal_at := old.terminal_at;
    end if;
  else
    new.terminal_at := null;
  end if;
  return new;
end;
$$;

drop trigger import_batch_terminal_timestamp on public.import_batches;
create trigger import_batch_terminal_timestamp
before insert or update of status, terminal_at, staging_purged_at on public.import_batches
for each row execute function private.set_import_terminal_at();

create or replace function public.list_import_staging_retention_candidates(
  p_limit integer default 100
)
returns table (
  batch_id uuid,
  batch_no text,
  status text,
  terminal_at timestamptz,
  staging_row_count bigint,
  payload_row_count bigint
)
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  perform private.require_import_retention_actor();
  if p_limit is null or p_limit not between 1 and 1000 then
    raise exception 'Import retention candidate limit must be between 1 and 1000' using errcode = '22023';
  end if;

  return query
  select
    b.id,
    b.batch_no,
    b.status,
    b.terminal_at,
    count(r.id)::bigint,
    count(r.id) filter (
      where r.raw_values <> '{}'::jsonb
         or r.normalized_values is not null
         or r.validation_errors <> '[]'::jsonb
    )::bigint
  from public.import_batches b
  left join public.import_rows r on r.batch_id = b.id
  where b.status in ('FAILED', 'CANCELLED')
    and b.terminal_at is not null
    and b.terminal_at <= transaction_timestamp() - interval '90 days'
    and b.staging_purged_at is null
  group by b.id, b.batch_no, b.status, b.terminal_at
  order by b.terminal_at, b.id
  limit p_limit;
end;
$$;

create or replace function public.purge_import_staging_payload(
  p_batch_id uuid
)
returns public.import_batches
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  batch_row public.import_batches;
begin
  perform private.require_import_retention_actor();
  if p_batch_id is null then
    raise exception 'Import retention batch id is required' using errcode = '22023';
  end if;

  -- This row lock serializes purge with any controlled FAILED restart/status
  -- transition. Eligibility is rechecked only after the lock is held.
  select * into batch_row
    from public.import_batches b
    where b.id = p_batch_id
    for update;
  if not found then
    raise exception 'Import batch was not found' using errcode = 'P0002';
  end if;

  if batch_row.staging_purged_at is not null then
    return batch_row;
  end if;
  if batch_row.status not in ('FAILED', 'CANCELLED')
     or batch_row.terminal_at is null
     or batch_row.terminal_at > transaction_timestamp() - interval '90 days' then
    raise exception 'Import batch is not eligible for staging retention purge' using errcode = '55000';
  end if;

  update public.import_rows
  set raw_values = '{}'::jsonb,
      normalized_values = null,
      validation_errors = '[]'::jsonb
  where batch_id = batch_row.id
    and (
      raw_values <> '{}'::jsonb
      or normalized_values is not null
      or validation_errors <> '[]'::jsonb
    );

  update public.import_batches
  set staging_purged_at = transaction_timestamp()
  where id = batch_row.id
  returning * into batch_row;

  return batch_row;
end;
$$;

revoke all on table public.import_batches, public.import_batch_chunks,
  public.import_rows, public.import_field_diffs from job_import_retention;
revoke all on function private.require_import_retention_actor() from public, anon, authenticated;
revoke all on function private.prevent_terminal_import_mutation() from public, anon, authenticated;
revoke all on function private.set_import_terminal_at() from public, anon, authenticated;
revoke all on function public.list_import_staging_retention_candidates(integer) from public, anon, authenticated;
revoke all on function public.purge_import_staging_payload(uuid) from public, anon, authenticated;
grant execute on function public.list_import_staging_retention_candidates(integer) to job_import_retention;
grant execute on function public.purge_import_staging_payload(uuid) to job_import_retention;
