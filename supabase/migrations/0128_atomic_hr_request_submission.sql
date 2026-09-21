begin;

do $migration$
begin
  if to_regprocedure(
    'public.create_hr_request_draft(text, date, text, jsonb, jsonb, text, text)'
  ) is null then
    raise exception using
      errcode = '42883',
      message = '0128 requires public.create_hr_request_draft(text, date, text, jsonb, jsonb, text, text)';
  end if;

  if to_regprocedure(
    'public.update_hr_request_draft(uuid, date, text, jsonb, jsonb, text, text)'
  ) is null then
    raise exception using
      errcode = '42883',
      message = '0128 requires public.update_hr_request_draft(uuid, date, text, jsonb, jsonb, text, text)';
  end if;

  if to_regprocedure('public.submit_hr_request(uuid, text, text)') is null then
    raise exception using
      errcode = '42883',
      message = '0128 requires public.submit_hr_request(uuid, text, text)';
  end if;
end;
$migration$;

-- PostgREST executes this wrapper in one transaction. Reuse the established
-- draft and submit RPCs so their row validation, lock ordering, reservations,
-- operation-command idempotency and audit behavior remain authoritative.
create or replace function public.submit_hr_request_with_lines(
  p_request_id uuid,
  p_request_no text,
  p_distribution_date date,
  p_note text,
  p_issue_lines jsonb,
  p_increase_lines jsonb,
  p_create_idempotency_key text,
  p_create_request_fingerprint text,
  p_update_idempotency_key text,
  p_update_request_fingerprint text,
  p_submit_idempotency_key text,
  p_submit_request_fingerprint text
)
returns public.hr_requests
language plpgsql
security definer
set search_path = pg_catalog, private
as $function$
declare
  current_account uuid;
  draft_row public.hr_requests;
  submitted_row public.hr_requests;
begin
  current_account := private.current_account_id();
  if auth.uid() is null
     or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null
     or not private.has_role('HR') then
    raise exception using errcode = '42501', message = 'HR role is required';
  end if;

  if p_request_id is null then
    draft_row := public.create_hr_request_draft(
      p_request_no,
      p_distribution_date,
      p_note,
      p_issue_lines,
      p_increase_lines,
      p_create_idempotency_key,
      p_create_request_fingerprint
    );
  else
    draft_row := public.update_hr_request_draft(
      p_request_id,
      p_distribution_date,
      p_note,
      p_issue_lines,
      p_increase_lines,
      p_update_idempotency_key,
      p_update_request_fingerprint
    );
  end if;

  if draft_row.id is null then
    raise exception 'HR request submission did not produce a draft';
  end if;

  submitted_row := public.submit_hr_request(
    draft_row.id,
    p_submit_idempotency_key,
    p_submit_request_fingerprint
  );
  return submitted_row;
end;
$function$;

revoke all on function public.submit_hr_request_with_lines(
  uuid, text, date, text, jsonb, jsonb, text, text, text, text, text, text
) from public, anon;
grant execute on function public.submit_hr_request_with_lines(
  uuid, text, date, text, jsonb, jsonb, text, text, text, text, text, text
) to authenticated;

commit;
