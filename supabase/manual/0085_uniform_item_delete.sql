-- Run this file once in the same Supabase project used by the deployed website.
--
-- This creates the separate hard-delete RPC for 商品管理. It is deliberately
-- not a replacement for apply_master_import: 停用 still uses the existing
-- master-data RPC and preserves all history. Hard delete is allowed only when
-- the item has no inventory balance and no inventory ledger record. Any other
-- business foreign-key reference also blocks deletion safely.

begin;

create or replace function public.delete_uniform_item(
  p_item_id uuid,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  item_row public.uniform_items;
begin
  current_account := private.current_account_id();
  if auth.uid() is null
     or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null then
    raise exception using errcode = '42501', message = 'Authenticated account is required';
  end if;

  if p_item_id is null
     or btrim(coalesce(p_idempotency_key, '')) = ''
     or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception using errcode = '22023', message = 'Uniform item delete fields are invalid';
  end if;

  if not (private.has_role('SYSTEM_ADMIN') or private.has_role('HR')) then
    raise exception using errcode = '42501', message = 'Role cannot delete uniform items';
  end if;

  insert into public.operation_commands (
    operation_code,
    idempotency_key,
    canonical_request_fingerprint,
    actor_account_id
  ) values (
    'DELETE_UNIFORM_ITEM',
    p_idempotency_key,
    p_request_fingerprint,
    current_account
  )
  on conflict on constraint operation_commands_operation_code_idempotency_key_key
  do nothing
  returning * into command_row;

  if command_row.id is null then
    select * into command_row
    from public.operation_commands
    where operation_code = 'DELETE_UNIFORM_ITEM'
      and idempotency_key = p_idempotency_key
    for update;

    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' then
      return true;
    end if;
    raise exception using errcode = '40001', message = 'Uniform item delete is already in progress or failed';
  end if;

  select * into item_row
  from public.uniform_items
  where id = p_item_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Uniform item not found';
  end if;

  if exists (select 1 from public.inventory_balances where item_id = p_item_id)
     or exists (select 1 from public.inventory_ledger_entries where item_id = p_item_id) then
    raise exception using
      errcode = '23514',
      message = 'Uniform item cannot be deleted because inventory records exist';
  end if;

  perform private.append_audit_event(
    current_account,
    'UNIFORM_ITEM_DELETED',
    'uniform_items',
    p_item_id,
    to_jsonb(item_row),
    null,
    null,
    command_row.id,
    null,
    jsonb_build_object('item_code', item_row.item_code)
  );

  begin
    delete from public.uniform_items where id = p_item_id;
  exception
    when foreign_key_violation then
      raise exception using
        errcode = '23514',
        message = 'Uniform item cannot be deleted because business history or related master data exists; use停用 instead';
  end;

  update public.operation_commands
  set status = 'SUCCEEDED',
      result_entity_type = 'uniform_items',
      result_entity_id = p_item_id,
      succeeded_at = now()
  where id = command_row.id;

  return true;
end;
$$;

comment on function public.delete_uniform_item(uuid, text, text)
  is 'Hard-deletes a uniform item only when no inventory balance or ledger records exist; related business foreign keys also block deletion.';

revoke all on function public.delete_uniform_item(uuid, text, text) from public, anon;
grant execute on function public.delete_uniform_item(uuid, text, text) to authenticated;

commit;

select p.oid::regprocedure as function_signature
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.oid = 'public.delete_uniform_item(uuid,text,text)'::regprocedure;
