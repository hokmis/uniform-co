-- Repair for an already-migrated project that still returns PostgreSQL 42P10
-- from apply_master_import after 0083's arbiter indexes are present.
--
-- This re-applies the current function definition from the database so
-- existing pooled sessions discard any cached PL/pgSQL statement plan that
-- was prepared before the unique indexes were created. It does not insert,
-- update, or delete application data.
-- Run in the same Supabase project used by the deployed website:
-- https://gqbphcbyeivbyesvqjta.supabase.co

begin;

do $repair$
declare
  current_definition text;
begin
  select pg_get_functiondef(
    'public.apply_master_import(text,text,jsonb,text,text)'::regprocedure
  )
  into current_definition;

  if current_definition is null then
    raise exception using
      errcode = '42883',
      message = 'public.apply_master_import(text,text,jsonb,text,text) was not found';
  end if;

  execute current_definition;
end;
$repair$;

commit;

select
  p.oid::regprocedure as function_signature,
  md5(pg_get_functiondef(p.oid)) as definition_md5,
  p.proconfig
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.oid = 'public.apply_master_import(text,text,jsonb,text,text)'::regprocedure;
