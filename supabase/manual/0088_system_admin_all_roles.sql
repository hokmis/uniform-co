begin;

-- Run this file in the target Supabase project if production SQL is managed
-- manually. It is safe to run again.
create or replace function private.has_role(required_role public.app_role)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, private
as $$
  select exists (
    select 1
    from public.user_roles ur
    where ur.account_id = private.current_account_id()
      and (
        ur.role_code = required_role
        or ur.role_code = 'SYSTEM_ADMIN'::public.app_role
      )
  )
$$;

revoke all on function private.has_role(public.app_role) from public, anon;
grant execute on function private.has_role(public.app_role) to authenticated;

comment on function private.has_role(public.app_role)
  is 'Returns true for the requested role or for an active SYSTEM_ADMIN capability umbrella.';

commit;
