-- The SSO adapter resolves central email identities against the local account
-- table. Keep this lookup indexed after the Auth user scan was removed from
-- the login hot path; this migration does not change data or authorization.

create index if not exists app_accounts_email_snapshot_idx
  on public.app_accounts (email_snapshot)
  where email_snapshot is not null;
