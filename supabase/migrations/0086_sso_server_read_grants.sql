begin;

-- The SSO adapter uses the target-only server role for two read-only probes:
-- resolving the current app account and checking its roles. Keep browser
-- access governed by the existing authenticated RLS policies; this grant is
-- only for the server-side service_role client.
grant usage on schema public to service_role;
grant select on public.app_accounts, public.user_roles to service_role;

commit;
