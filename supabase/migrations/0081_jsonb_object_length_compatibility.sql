begin;

-- PostgreSQL provides jsonb_array_length/jsonb_object_keys, but not a
-- jsonb_object_length(jsonb) builtin. The master-data RPCs run with
-- search_path = pg_catalog, private and already reference this compatibility
-- name, so provide a private, immutable bridge without rewriting an applied
-- master-data function.
create or replace function private.jsonb_object_length(p_value jsonb)
returns integer
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select count(*)::integer from jsonb_object_keys(p_value);
$$;

revoke all on function private.jsonb_object_length(jsonb) from public, anon, authenticated;

commit;
