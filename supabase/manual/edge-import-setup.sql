-- Supabase Edge durable import setup.
-- Run in the SAME target Supabase project. This file contains no password,
-- token, service-role key, or connection string.

-- 1) Read-only checks. The first query must return exactly one active role.
select rolname, rolcanlogin, rolinherit
from pg_catalog.pg_roles
where rolname = 'job_import_worker';

select db_role, account_id, is_active
from private.job_actor_bindings
where db_role = 'job_import_worker';

select routine_schema, routine_name, routine_type
from information_schema.routines
where routine_schema = 'public'
  and routine_name in (
    'list_import_work',
    'get_import_reference_snapshot',
    'confirm_import_upload',
    'prepare_import_chunks',
    'claim_import_chunk',
    'complete_import_chunk',
    'fail_import_chunk',
    'claim_import_apply',
    'apply_import_batch'
  )
order by routine_name;

-- 2) Only if rolcanlogin is false, set the EXISTING same-name role to LOGIN
-- through your protected DB credential workflow. Do not use a new role.
-- Replace the placeholder outside this repository and never commit the value:
-- alter role job_import_worker login noinherit password '<edge-only-secret>';

-- 3) If the binding query returned no active row, choose an existing active
-- SYSTEM_ADMIN app_accounts.id and bind that actor. Do not create a fake
-- account for this purpose.
-- select id, login_name
-- from public.app_accounts
-- where is_active
-- order by created_at;
-- insert into private.job_actor_bindings (db_role, account_id, is_active)
-- values ('job_import_worker', '<existing-active-system-admin-uuid>'::uuid, true)
-- on conflict (db_role) do update
-- set account_id = excluded.account_id, is_active = true;

-- 4) After the Edge Function secret IMPORT_EDGE_DATABASE_URL is configured,
-- run the read-only checks again. The function must connect as
-- job_import_worker and must use the same target project as the website.
