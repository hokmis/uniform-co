-- Recover a START_IMPORT_UPLOAD result after a lost browser response.
create or replace function public.get_import_upload_status(
  p_import_type text,
  p_idempotency_key text
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
  normalized_type text := upper(btrim(coalesce(p_import_type, '')));
begin
  actor_id := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or actor_id is null
     or btrim(coalesce(p_idempotency_key, '')) = ''
     or normalized_type not in ('INSTITUTIONS', 'DEPARTMENTS', 'EMPLOYEES', 'UNIFORM_ITEMS', 'SUPPLIERS', 'SUPPLIER_ITEMS', 'OPENING_BALANCE') then
    raise exception using errcode = '42501', message = 'Authenticated import recovery is required';
  end if;
  select * into command_row
  from public.operation_commands
  where operation_code = 'START_IMPORT_UPLOAD_' || normalized_type
    and idempotency_key = p_idempotency_key
    and actor_account_id = actor_id
  for update;
  if not found or command_row.status <> 'SUCCEEDED' or command_row.result_entity_id is null then
    return null;
  end if;
  select * into batch_row from public.import_batches where id = command_row.result_entity_id;
  return batch_row;
end;
$$;

revoke all on function public.get_import_upload_status(text, text) from public, anon;
grant execute on function public.get_import_upload_status(text, text) to authenticated;

-- The legacy starter RPC namespaces its command by import type. Keep that
-- compatibility while enforcing the global idempotency-key contract: a key
-- cannot silently create another upload command for a different type.
create or replace function private.prevent_import_upload_key_reuse()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  if new.operation_code like 'START_IMPORT_UPLOAD_%'
     then
    -- Namespace checks must serialize before either insert commits; without
    -- this transaction advisory lock two different upload types can both
    -- pass the READ COMMITTED existence test for the same key.
    perform pg_advisory_xact_lock(hashtext(new.idempotency_key));
  end if;
  if new.operation_code like 'START_IMPORT_UPLOAD_%'
     and exists (
       select 1
       from public.operation_commands prior
       where prior.idempotency_key = new.idempotency_key
         and prior.operation_code like 'START_IMPORT_UPLOAD_%'
         and prior.operation_code <> new.operation_code
     ) then
    raise exception using errcode = '40001', message = 'Import upload idempotency key is already bound to another import type';
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_import_upload_key_reuse on public.operation_commands;
create trigger prevent_import_upload_key_reuse
before insert on public.operation_commands
for each row execute function private.prevent_import_upload_key_reuse();

revoke all on function private.prevent_import_upload_key_reuse() from public, anon, authenticated;
