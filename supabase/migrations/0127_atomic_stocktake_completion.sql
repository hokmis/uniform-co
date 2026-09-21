-- Complete the common stocktake path in one transaction while reusing the
-- existing snapshot, role, idempotency, reservation, and posting rules.
create or replace function public.complete_stocktake(
  p_stocktake_id uuid,
  p_stocktake_no text,
  p_warehouse_id uuid,
  p_note text,
  p_lines jsonb,
  p_create_idempotency_key text,
  p_create_request_fingerprint text,
  p_update_idempotency_key text,
  p_update_request_fingerprint text,
  p_post_idempotency_key text,
  p_post_request_fingerprint text
)
returns public.stocktakes
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  draft_row public.stocktakes;
  completed_row public.stocktakes;
begin
  current_account := private.current_account_id();
  if auth.uid() is null
     or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null
     or (not private.has_role('HR') and not private.has_role('WAREHOUSE')) then
    raise exception using errcode = '42501', message = 'HR or WAREHOUSE role is required';
  end if;

  if p_stocktake_id is null then
    draft_row := public.create_stocktake_draft(
      p_stocktake_no,
      p_warehouse_id,
      p_note,
      p_lines,
      p_create_idempotency_key,
      p_create_request_fingerprint
    );
  else
    draft_row := public.update_stocktake_draft(
      p_stocktake_id,
      p_note,
      p_lines,
      false,
      p_update_idempotency_key,
      p_update_request_fingerprint
    );
  end if;

  if draft_row.id is null then
    raise exception 'Stocktake completion did not produce a draft';
  end if;

  completed_row := public.post_stocktake(
    draft_row.id,
    p_post_idempotency_key,
    p_post_request_fingerprint
  );
  return completed_row;
end;
$$;

revoke all on function public.complete_stocktake(uuid, text, uuid, text, jsonb, text, text, text, text, text, text)
  from public, anon;
grant execute on function public.complete_stocktake(uuid, text, uuid, text, jsonb, text, text, text, text, text, text)
  to authenticated;
