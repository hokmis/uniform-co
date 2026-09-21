-- Shape the SYSTEM_ADMIN account directory and stored roles into one read.
-- security_invoker keeps app_accounts and user_roles RLS authoritative.

create or replace view public.v_account_directory
with (security_invoker = true)
as
select
  account.id,
  account.auth_user_id,
  account.login_name,
  account.display_name,
  account.email_snapshot,
  account.is_active,
  coalesce(
    jsonb_agg(to_jsonb(account_role.role_code) order by account_role.role_code)
      filter (where account_role.role_code is not null),
    '[]'::jsonb
  ) as role_codes
from public.app_accounts account
left join public.user_roles account_role
  on account_role.account_id = account.id
group by
  account.id,
  account.auth_user_id,
  account.login_name,
  account.display_name,
  account.email_snapshot,
  account.is_active;

revoke all on table public.v_account_directory from public, anon, authenticated;
grant select on public.v_account_directory to authenticated;
