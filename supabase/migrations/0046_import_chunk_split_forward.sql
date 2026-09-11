-- Keep the initial PARSE lease bounded.  The upload confirmation RPC predates
-- the worker and creates one covering chunk; split it in the same transaction
-- before any worker can claim it, so complete_import_chunk stays well below its
-- JSON/payload guard.
create or replace function private.split_large_import_parse_chunk()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  chunk_size constant integer := 50;
  next_start integer;
  next_end integer;
begin
  if pg_trigger_depth() > 1 or new.phase <> 'PARSE' or new.chunk_no <> 1
     or new.end_row_number - new.start_row_number + 1 <= chunk_size then
    return new;
  end if;
  update public.import_batch_chunks
  set end_row_number = new.start_row_number + chunk_size - 1
  where id = new.id;
  next_start := new.start_row_number + chunk_size;
  while next_start <= new.end_row_number loop
    next_end := least(next_start + chunk_size - 1, new.end_row_number);
    insert into public.import_batch_chunks(
      batch_id, phase, chunk_no, start_row_number, end_row_number, idempotency_key
    ) values (
      new.batch_id, new.phase,
      ((next_start - new.start_row_number) / chunk_size) + 1,
      next_start, next_end,
      'PARSE-' || new.batch_id::text || '-' || (((next_start - new.start_row_number) / chunk_size) + 1)::text
    ) on conflict (batch_id, phase, chunk_no) do nothing;
    next_start := next_end + 1;
  end loop;
  return new;
end;
$$;

drop trigger if exists import_batch_chunks_split_large_parse on public.import_batch_chunks;
create trigger import_batch_chunks_split_large_parse
after insert on public.import_batch_chunks
for each row execute function private.split_large_import_parse_chunk();

revoke all on function private.split_large_import_parse_chunk() from public, anon, authenticated;

create or replace function private.bump_import_cursor_after_lease_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  if (new.status in ('RETRY_WAIT', 'FAILED') and old.status = 'LEASED')
     or (new.status = 'LEASED' and old.status in ('LEASED', 'PROCESSING')
         and old.lease_expires_at is not null and old.lease_expires_at <= transaction_timestamp()) then
    update public.import_batches
    set cursor_version = cursor_version + 1
    where id = new.batch_id;
  end if;
  return new;
end;
$$;

drop trigger if exists import_batch_chunks_bump_cursor on public.import_batch_chunks;
create trigger import_batch_chunks_bump_cursor
after update of status, lease_token, lease_expires_at on public.import_batch_chunks
for each row execute function private.bump_import_cursor_after_lease_change();

revoke all on function private.bump_import_cursor_after_lease_change() from public, anon, authenticated;
