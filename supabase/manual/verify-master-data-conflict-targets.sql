-- Read-only diagnosis for: there is no unique or exclusion constraint matching
-- the ON CONFLICT specification.
-- Run this in the same Supabase project configured by the deployed website:
-- https://gqbphcbyeivbyesvqjta.supabase.co
-- This file does not create, alter, or delete anything.

with expected(table_name, index_name) as (
  values
    ('operation_commands', 'operation_commands_operation_idempotency_conflict_idx'),
    ('institutions', 'institutions_code_conflict_idx'),
    ('departments', 'departments_institution_code_conflict_idx'),
    ('uniform_items', 'uniform_items_item_code_conflict_idx'),
    ('suppliers', 'suppliers_supplier_code_conflict_idx'),
    ('supplier_uniform_items', 'supplier_uniform_items_supplier_item_conflict_idx')
)
select
  e.table_name,
  e.index_name,
  case when i.indexname is null then 'MISSING' else 'PRESENT' end as status,
  i.indexdef
from expected e
left join pg_indexes i
  on i.schemaname = 'public'
 and i.tablename = e.table_name
 and i.indexname = e.index_name
order by e.table_name;

select
  p.oid::regprocedure as function_signature,
  n.nspname as schema_name,
  p.prokind,
  p.prosrc like '%on conflict (item_code)%' as contains_item_code_conflict,
  p.prosrc like '%on conflict (supplier_code)%' as contains_supplier_code_conflict,
  p.prosrc like '%on conflict (operation_code, idempotency_key)%' as contains_idempotency_conflict
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'apply_master_import';

select
  to_regprocedure('public.apply_master_import(text, text, jsonb, text, text)') as expected_apply_master_import;

select
  version,
  case when version in ('0080', '0081', '0082', '0083') then 'EXPECTED' else 'OTHER' end as status
from supabase_migrations.schema_migrations
where version in ('0080', '0081', '0082', '0083')
order by version;

select
  schemaname,
  tablename,
  indexname,
  indexdef
from pg_indexes
where schemaname = 'public'
  and tablename in ('operation_commands', 'institutions', 'departments', 'uniform_items', 'suppliers', 'supplier_uniform_items')
order by tablename, indexname;
