-- Restrict human login names to 3-50 lowercase ASCII letters and digits.
-- Do not rewrite existing values because login_name is coupled to the Auth email.

do $$
begin
  if exists (
    select 1
    from public.app_accounts
    where login_name is not null
      and login_name !~ '^[a-z0-9]{3,50}$'
  ) then
    raise exception
      'Existing login_name values contain unsupported characters; update the corresponding Auth identities before applying migration 0069'
      using errcode = '23514';
  end if;
end;
$$;

alter table public.app_accounts
  drop constraint if exists app_accounts_login_name_format;

alter table public.app_accounts
  add constraint app_accounts_login_name_format
  check (login_name is null or login_name ~ '^[a-z0-9]{3,50}$');

comment on column public.app_accounts.login_name is
  'Case-normalized human login name containing 3-50 lowercase ASCII letters or digits. NULL only identifies a legacy email-login account until SYSTEM_ADMIN assigns a login name.';
