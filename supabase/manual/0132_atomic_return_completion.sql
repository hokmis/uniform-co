-- Complete the common one-step return path in one database transaction and
-- one browser round trip, reusing the existing guarded and idempotent RPCs.
create or replace function public.complete_return_note(
  p_return_no text,
  p_original_hr_request_id uuid,
  p_return_date date,
  p_reason_code text,
  p_reason text,
  p_note text,
  p_lines jsonb,
  p_create_idempotency_key text,
  p_create_request_fingerprint text,
  p_post_idempotency_key text,
  p_post_request_fingerprint text
)
returns public.return_notes
language plpgsql
security invoker
set search_path = pg_catalog, private
as $$
declare
  return_row public.return_notes;
begin
  return_row := public.create_return_note_draft(
    p_return_no,
    p_original_hr_request_id,
    p_return_date,
    p_reason_code,
    p_reason,
    p_note,
    p_lines,
    p_create_idempotency_key,
    p_create_request_fingerprint
  );

  if return_row.id is null then
    raise exception 'Return draft creation returned no record';
  end if;
  -- A retry after a committed response loss replays the create idempotency key;
  -- the existing draft RPC returns the already-posted row in that case.
  if return_row.status = 'POSTED' then
    return return_row;
  end if;
  if return_row.status <> 'DRAFT' then
    raise exception 'Return note is not postable';
  end if;

  return public.post_return_note(
    return_row.id,
    p_post_idempotency_key,
    p_post_request_fingerprint
  );
end;
$$;

revoke all on function public.complete_return_note(text, uuid, date, text, text, text, jsonb, text, text, text, text)
  from public, anon;
grant execute on function public.complete_return_note(text, uuid, date, text, text, text, jsonb, text, text, text, text)
  to authenticated;
