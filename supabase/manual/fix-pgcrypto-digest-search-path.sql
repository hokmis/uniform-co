-- Run once in the Supabase SQL Editor when an existing database reports:
-- function digest(text, unknown) does not exist.
-- This is a compatibility hotfix for migrations already applied manually.

begin;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_extension
    where extname = 'pgcrypto'
  ) then
    execute 'create extension pgcrypto';
  end if;
end;
$$;

create or replace function private.digest(
  p_data text,
  p_algorithm text
)
returns bytea
language plpgsql
stable
strict
set search_path = pg_catalog, private
as $$
declare
  digest_schema text;
  digest_value bytea;
begin
  select n.nspname
    into digest_schema
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  join pg_catalog.pg_depend d
    on d.classid = 'pg_catalog.pg_proc'::regclass
   and d.objid = p.oid
   and d.refclassid = 'pg_catalog.pg_extension'::regclass
  join pg_catalog.pg_extension e on e.oid = d.refobjid
  where e.extname = 'pgcrypto'
    and p.proname = 'digest'
    and pg_catalog.pg_get_function_identity_arguments(p.oid) = 'text, text'
  order by case when n.nspname = 'extensions' then 0 else 1 end, n.nspname
  limit 1;

  if digest_schema is null then
    raise exception 'pgcrypto digest(text,text) is not available' using errcode = '42883';
  end if;

  execute format('select %I.digest($1, $2)', digest_schema)
    into digest_value
    using p_data, p_algorithm;
  return digest_value;
end;
$$;

revoke all on function private.digest(text, text) from public, anon, authenticated;

commit;

select
  to_regprocedure('private.digest(text,text)') as digest_bridge,
  encode(private.digest('uniform-co-digest-smoke', 'sha256'), 'hex') as digest_smoke;
