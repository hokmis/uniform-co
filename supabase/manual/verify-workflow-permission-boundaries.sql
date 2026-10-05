-- Production-safe negative acceptance: no credentials, no committed writes.
-- Run the entire script. Any unexpected success aborts; each test rolls back.
begin;
set local role anon;
do $$
begin
  begin
    perform public.cancel_hr_request(null, 'QA permission check', 'QA-DENIED-ANON', 'QA-DENIED-ANON');
    raise exception 'Anonymous HR cancellation was unexpectedly accepted';
  exception when insufficient_privilege then null;
  end;
end;
$$;
rollback;

begin;
do $$
declare
  actor uuid;
begin
  select a.auth_user_id into strict actor
  from public.app_accounts a
  where a.is_active and a.auth_user_id is not null
    and (select array_agg(r.role_code::text order by r.role_code::text)
         from public.user_roles r where r.account_id = a.id) = array['WAREHOUSE'];
  perform set_config('request.jwt.claims', jsonb_build_object('sub', actor::text, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', actor::text, true);
end;
$$;
set local role authenticated;
do $$
begin
  if auth.uid() is null then raise exception 'QA actor is missing'; end if;
  begin
    perform public.cancel_hr_request(null, 'QA permission check', 'QA-DENIED-HR', 'QA-DENIED-HR');
    raise exception 'Warehouse-only HR cancellation was unexpectedly accepted';
  exception when insufficient_privilege then null;
  end;
end;
$$;
rollback;

select true as anonymous_hr_cancellation_denied,
       true as warehouse_only_hr_cancellation_denied,
       true as tests_rolled_back;
