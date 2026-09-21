-- Align the replenishment POST lock order with HR submit/cancel and the
-- warehouse shipment path.  0096's implementation locks the replenishment
-- request before the item mutexes; the other workflows lock item mutexes
-- first.  Under concurrent submit/cancel/post operations that inversion can
-- deadlock.  Keep the tested 0096 implementation, move it behind a private
-- name, and let the public entry point acquire the item mutexes first.

alter function public.post_replenishment_request_with_lines(uuid, jsonb, text, text)
  set schema private;

revoke all on function private.post_replenishment_request_with_lines(uuid, jsonb, text, text)
  from public, anon, authenticated;

create or replace function public.post_replenishment_request_with_lines(
  p_request_id uuid,
  p_transfer_lines jsonb,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.replenishment_requests
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  item_id_row record;
  item_ids uuid[];
begin
  current_account := private.current_account_id();
  if auth.uid() is null
     or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null
     or not private.has_role('WAREHOUSE') then
    raise exception using errcode = '42501', message = 'WAREHOUSE role is required';
  end if;
  if p_request_id is null then
    raise exception 'Replenishment request id is required';
  end if;

  select coalesce(array_agg(distinct line_row.item_id order by line_row.item_id), '{}'::uuid[])
    into item_ids
  from public.replenishment_request_lines line_row
  where line_row.request_id = p_request_id;

  if cardinality(item_ids) > 0 then
    insert into public.inventory_item_locks (item_id)
    select requested.item_id
    from unnest(item_ids) as requested(item_id)
    order by requested.item_id
    on conflict (item_id) do nothing;

    for item_id_row in
      select requested.item_id
      from unnest(item_ids) as requested(item_id)
      order by requested.item_id
    loop
      perform 1
      from public.inventory_item_locks lock_row
      where lock_row.item_id = item_id_row.item_id
      for update;
    end loop;
  end if;

  -- The moved implementation repeats the authoritative request, line,
  -- balance and status checks while these item locks are held.
  return private.post_replenishment_request_with_lines(
    p_request_id,
    p_transfer_lines,
    p_idempotency_key,
    p_request_fingerprint
  );
end;
$$;

revoke all on function public.post_replenishment_request_with_lines(uuid, jsonb, text, text)
  from public, anon;
grant execute on function public.post_replenishment_request_with_lines(uuid, jsonb, text, text)
  to authenticated;
