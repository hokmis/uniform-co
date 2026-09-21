begin;

-- The deployed 0080 apply RPC has local variables named item_code and
-- supplier_code. PostgreSQL treats an unqualified name that matches a query
-- column as ambiguous inside PL/pgSQL. Patch the existing function in place so
-- the original validation, idempotency and upsert logic remains unchanged.
do $migration$
declare
  current_definition text;
  patched_definition text;
begin
  select pg_get_functiondef(
    'public.apply_master_import(text,text,jsonb,text,text)'::regprocedure
  )
  into current_definition;

  if current_definition is null
     or position('private.has_role(''SYSTEM_ADMIN'')' in current_definition) = 0 then
    raise exception using
      errcode = '55000',
      message = '0080_master_data_system_admin_access must be applied first';
  end if;

  patched_definition := regexp_replace(
    current_definition,
    '(?is)(AS \$[^$]*\$)\s*DECLARE',
    E'\\1\n#variable_conflict use_variable\nDECLARE'
  );

  if patched_definition = current_definition then
    raise exception using
      errcode = '55000',
      message = 'Could not add variable conflict policy to apply_master_import';
  end if;

  execute patched_definition;
end;
$migration$;

commit;
