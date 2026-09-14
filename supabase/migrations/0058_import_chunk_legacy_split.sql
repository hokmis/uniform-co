-- Forward-safe repair for batches created before 0046 installed the
-- after-insert bounded PARSE chunk splitter. The worker invokes this function,
-- which acquires the batch lock before changing anything, so audit/terminal
-- guards see the real worker actor and no migration-owner data rewrite is
-- required.

create or replace function public.prepare_import_chunks(
  p_batch_id uuid,
  p_phase text
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  actor_id uuid;
  batch_row public.import_batches;
  chunk_row public.import_batch_chunks;
  original_end integer;
  next_start integer;
  next_end integer;
  next_chunk_no integer;
  prepared_count integer := 0;
  chunk_size constant integer := 50;
begin
  actor_id := private.require_import_worker();
  if p_batch_id is null or upper(btrim(coalesce(p_phase, ''))) <> 'PARSE' then
    raise exception 'Only PARSE chunks can be prepared' using errcode = '22023';
  end if;
  select * into batch_row
  from public.import_batches
  where id = p_batch_id
  for update;
  if not found or batch_row.status in ('APPLIED', 'CANCELLED', 'FAILED') then
    raise exception 'Import batch is not available for chunk preparation' using errcode = '55000';
  end if;

  for chunk_row in
    select c.*
    from public.import_batch_chunks c
    where c.batch_id = p_batch_id
      and c.phase = 'PARSE'
      and c.status = 'PENDING'
      and c.attempt_count = 0
      and c.lease_token is null
      and c.end_row_number - c.start_row_number + 1 > chunk_size
      and not exists (
        select 1
        from public.import_batch_chunks sibling
        where sibling.batch_id = c.batch_id
          and sibling.phase = c.phase
          and sibling.chunk_no > c.chunk_no
      )
    order by c.chunk_no
    for update
  loop
    original_end := chunk_row.end_row_number;
    update public.import_batch_chunks
    set end_row_number = chunk_row.start_row_number + chunk_size - 1
    where id = chunk_row.id;

    next_start := chunk_row.start_row_number + chunk_size;
    next_chunk_no := chunk_row.chunk_no + 1;
    while next_start <= original_end loop
      next_end := least(next_start + chunk_size - 1, original_end);
      insert into public.import_batch_chunks(
        batch_id, phase, chunk_no, start_row_number, end_row_number, idempotency_key
      ) values (
        p_batch_id, 'PARSE', next_chunk_no, next_start, next_end,
        'PARSE-' || p_batch_id::text || '-' || next_chunk_no::text
      ) on conflict (batch_id, phase, chunk_no) do nothing;
      next_start := next_end + 1;
      next_chunk_no := next_chunk_no + 1;
    end loop;
    prepared_count := prepared_count + 1;
  end loop;
  return prepared_count;
end;
$$;

revoke all on function public.prepare_import_chunks(uuid, text) from public, anon, authenticated;
grant execute on function public.prepare_import_chunks(uuid, text) to job_import_worker;
