begin;

do $migration$
begin
  if to_regprocedure(
    'public.create_replenishment_draft(text, text, jsonb, text, text)'
  ) is null then
    raise exception using
      errcode = '42883',
      message = '0130 requires public.create_replenishment_draft(text, text, jsonb, text, text)';
  end if;

  if to_regprocedure(
    'public.update_replenishment_request_draft(uuid, text, jsonb, text, text)'
  ) is null then
    raise exception using
      errcode = '42883',
      message = '0130 requires public.update_replenishment_request_draft(uuid, text, jsonb, text, text)';
  end if;

  if to_regprocedure('public.submit_replenishment_request(uuid, text, text)') is null then
    raise exception using
      errcode = '42883',
      message = '0130 requires public.submit_replenishment_request(uuid, text, text)';
  end if;
end;
$migration$;

-- PostgREST runs the wrapper and its established idempotent draft/submit RPCs
-- in one transaction, preserving their authorization, validation, locks and audit.
create or replace function public.submit_replenishment_request_with_lines(
  p_request_id uuid,
  p_request_no text,
  p_note text,
  p_lines jsonb,
  p_create_idempotency_key text,
  p_create_request_fingerprint text,
  p_update_idempotency_key text,
  p_update_request_fingerprint text,
  p_submit_idempotency_key text,
  p_submit_request_fingerprint text
)
returns public.replenishment_requests
language plpgsql
security definer
set search_path = pg_catalog, private
as $function$
declare
  current_account uuid;
  draft_row public.replenishment_requests;
  submitted_row public.replenishment_requests;
begin
  current_account := private.current_account_id();
  if auth.uid() is null
     or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null
     or not private.has_role('HR') then
    raise exception using errcode = '42501', message = 'HR role is required';
  end if;

  if p_request_id is null then
    draft_row := public.create_replenishment_draft(
      p_request_no,
      p_note,
      p_lines,
      p_create_idempotency_key,
      p_create_request_fingerprint
    );
  else
    draft_row := public.update_replenishment_request_draft(
      p_request_id,
      p_note,
      p_lines,
      p_update_idempotency_key,
      p_update_request_fingerprint
    );
  end if;

  if draft_row.id is null then
    raise exception 'Replenishment submission did not produce a draft';
  end if;

  submitted_row := public.submit_replenishment_request(
    draft_row.id,
    p_submit_idempotency_key,
    p_submit_request_fingerprint
  );
  return submitted_row;
end;
$function$;

revoke all on function public.submit_replenishment_request_with_lines(
  uuid, text, text, jsonb, text, text, text, text, text, text
) from public, anon;
grant execute on function public.submit_replenishment_request_with_lines(
  uuid, text, text, jsonb, text, text, text, text, text, text
) to authenticated;

commit;
