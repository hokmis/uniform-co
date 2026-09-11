\set ON_ERROR_STOP on

do $$
declare
  conflicting_objects text;
begin
  if to_regclass('auth.users') is null
     or to_regclass('auth.identities') is null
     or to_regclass('auth.mfa_factors') is null then
    raise exception 'restore target is not a compatible Supabase database: required Auth tables are missing';
  end if;

  if exists (select 1 from auth.users limit 1)
     or exists (select 1 from auth.identities limit 1)
     or exists (select 1 from auth.mfa_factors limit 1) then
    raise exception 'restore target Auth is not empty';
  end if;

  select string_agg(format('%I.%I (%s)', schema_name, object_name, object_kind), ', ' order by schema_name, object_name, object_kind)
  into conflicting_objects
  from (
    select
      n.nspname as schema_name,
      c.relname as object_name,
      case c.relkind
        when 'r' then 'table'
        when 'p' then 'partitioned table'
        when 'v' then 'view'
        when 'm' then 'materialized view'
        when 'S' then 'sequence'
        when 'f' then 'foreign table'
        else c.relkind::text
      end as object_kind
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'private')
      and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
      and not exists (
        select 1
        from pg_depend d
        join pg_extension e on e.oid = d.refobjid
        where d.classid = 'pg_class'::regclass
          and d.objid = c.oid
          and d.deptype = 'e'
      )

    union all

    select
      n.nspname,
      p.proname,
      'routine'
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and not exists (
        select 1
        from pg_depend d
        join pg_extension e on e.oid = d.refobjid
        where d.classid = 'pg_proc'::regclass
          and d.objid = p.oid
          and d.deptype = 'e'
      )

    union all

    select
      n.nspname,
      t.typname,
      case t.typtype when 'e' then 'enum type' else 'domain type' end
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname in ('public', 'private')
      and t.typtype in ('e', 'd')
      and not exists (
        select 1
        from pg_depend d
        join pg_extension e on e.oid = d.refobjid
        where d.classid = 'pg_type'::regclass
          and d.objid = t.oid
          and d.deptype = 'e'
      )
  ) conflicts;

  if conflicting_objects is not null then
    raise exception 'restore target application namespaces are not empty: %', conflicting_objects;
  end if;
end
$$;
