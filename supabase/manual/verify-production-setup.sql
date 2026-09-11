-- Read-only production setup checks.
-- Run this after applying 0068 through 0075 in ascending order.
-- This script does not create, alter, delete, or repair migration history.
-- If the migrations were pasted into Supabase SQL Editor, the first result can
-- still show MISSING because SQL Editor does not update the migration ledger.
-- Use the feature probes below to confirm the SQL actually took effect, then
-- reconcile migration history with the Supabase CLI before using db push again.

with expected(version) as (
  values
    ('0068'),
    ('0069'),
    ('0070'),
    ('0071'),
    ('0072'),
    ('0073'),
    ('0074'),
    ('0075')
)
select
  e.version,
  case when m.version is null then 'MISSING' else 'APPLIED' end as status
from expected e
left join supabase_migrations.schema_migrations m on m.version = e.version
order by e.version;

select
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'app_accounts' and column_name = 'login_name'
  ) as account_login_name_column,
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'import_batches' and column_name = 'terminal_at'
  ) as import_terminal_at_column,
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'import_batches' and column_name = 'staging_purged_at'
  ) as staging_purged_at_column,
  to_regprocedure('public.list_import_staging_retention_candidates(integer)') is not null as retention_list_rpc,
  to_regprocedure('public.purge_import_staging_payload(uuid)') is not null as retention_purge_rpc,
  to_regprocedure('private.digest(text,text)') is not null as digest_bridge,
  case
    when exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'app_accounts' and column_name = 'login_name'
    )
    and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'import_batches' and column_name = 'terminal_at'
    )
    and exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'import_batches' and column_name = 'staging_purged_at'
    )
    and to_regprocedure('public.list_import_staging_retention_candidates(integer)') is not null
    and to_regprocedure('public.purge_import_staging_payload(uuid)') is not null
    and to_regprocedure('private.digest(text,text)') is not null
    then 'FEATURES PRESENT'
    else 'CHECK: one or more pending migrations did not take effect'
  end as migration_feature_status;

select
  b.name as bucket,
  b.public,
  case when b.public then 'CHECK: bucket must be private' else 'OK' end as check_result
from storage.buckets b
where b.name in ('uniform-imports', 'uniform-artifacts', 'uniform-render-temp', 'uniform-pdf', 'uniform-erp')
order by b.name;

select
  r.rolname as db_role,
  r.rolcanlogin as can_login,
  case
    when r.rolname in ('job_import_worker', 'job_document_renderer', 'job_erp_renderer', 'job_renderer_storage_proxy', 'job_storage_cleanup', 'job_import_retention')
      and r.rolcanlogin then 'ENABLED: verify protected deployment and secret manager'
    when r.rolname in ('job_import_worker', 'job_document_renderer', 'job_erp_renderer', 'job_renderer_storage_proxy', 'job_storage_cleanup', 'job_import_retention')
      then 'NOLOGIN: safe until the corresponding worker is deployed'
    else 'CHECK'
  end as status
from pg_roles r
where r.rolname in ('job_import_worker', 'job_document_renderer', 'job_erp_renderer', 'job_renderer_storage_proxy', 'job_storage_cleanup', 'job_import_retention')
order by r.rolname;

select
  b.db_role,
  b.account_id,
  b.is_active,
  a.login_name,
  a.email_snapshot,
  case when b.is_active and a.is_active then 'ACTIVE' else 'CHECK' end as status
from private.job_actor_bindings b
left join public.app_accounts a on a.id = b.account_id
where b.db_role in ('job_import_worker', 'job_document_renderer', 'job_erp_renderer', 'job_renderer_storage_proxy', 'job_storage_cleanup', 'job_import_retention')
order by b.db_role;

select
  (select count(*) from public.app_accounts where is_active) as active_accounts,
  (select count(*)
   from public.user_roles r
   join public.app_accounts a on a.id = r.account_id
   where a.is_active) as active_role_assignments,
  (select count(*) from public.institutions where is_active) as active_institutions,
  (select count(*) from public.departments where is_active) as active_departments,
  (select count(*) from public.employees where employment_status = 'ACTIVE') as active_employees,
  (select count(*) from public.uniform_items where is_active) as active_uniform_items,
  (select count(*) from public.warehouses where is_active) as active_warehouses;

select
  required.purpose,
  w.code,
  w.name,
  w.is_active,
  case when w.id is null then 'MISSING' else 'OK' end as status
from (values ('HR'::text), ('GENERAL'::text)) as required(purpose)
left join public.warehouses w
  on w.purpose = required.purpose
 and w.is_active
order by required.purpose;
