-- Repair for a deployed project that still returns PostgreSQL 42P10 after
-- 0083's unique indexes, function definition, and trigger chain all verify.
--
-- This changes only the apply_master_import function definition. It replaces
-- inferred ON CONFLICT targets with the existing named unique constraints,
-- after checking every constraint is present. It does not write application
-- data. Run in the same Supabase project used by the deployed website:
-- https://gqbphcbyeivbyesvqjta.supabase.co

begin;

do $repair$
declare
  current_definition text;
  patched_definition text;
  missing_constraints text;
begin
  select string_agg(expected.constraint_name, ', ' order by expected.constraint_name)
  into missing_constraints
  from (
    values
      ('operation_commands_operation_code_idempotency_key_key'::text),
      ('institutions_code_key'::text),
      ('departments_institution_id_code_key'::text),
      ('uniform_items_item_code_key'::text),
      ('suppliers_supplier_code_key'::text),
      ('supplier_uniform_items_pkey'::text)
  ) as expected(constraint_name)
  where not exists (
    select 1
    from pg_constraint c
    where c.connamespace = 'public'::regnamespace
      and c.conname = expected.constraint_name
  );

  if missing_constraints is not null then
    raise exception using
      errcode = '55000',
      message = 'Required master-data constraints are missing: ' || missing_constraints;
  end if;

  select pg_get_functiondef(
    'public.apply_master_import(text,text,jsonb,text,text)'::regprocedure
  )
  into current_definition;

  if current_definition is null then
    raise exception using
      errcode = '42883',
      message = 'public.apply_master_import(text,text,jsonb,text,text) was not found';
  end if;

  patched_definition := current_definition;
  patched_definition := regexp_replace(
    patched_definition,
    'on[[:space:]]+conflict[[:space:]]*\([[:space:]]*operation_code[[:space:]]*,[[:space:]]*idempotency_key[[:space:]]*\)',
    'on conflict on constraint operation_commands_operation_code_idempotency_key_key',
    'gi'
  );
  patched_definition := regexp_replace(
    patched_definition,
    'on[[:space:]]+conflict[[:space:]]*\([[:space:]]*institution_id[[:space:]]*,[[:space:]]*code[[:space:]]*\)',
    'on conflict on constraint departments_institution_id_code_key',
    'gi'
  );
  patched_definition := regexp_replace(
    patched_definition,
    'on[[:space:]]+conflict[[:space:]]*\([[:space:]]*item_code[[:space:]]*\)',
    'on conflict on constraint uniform_items_item_code_key',
    'gi'
  );
  patched_definition := regexp_replace(
    patched_definition,
    'on[[:space:]]+conflict[[:space:]]*\([[:space:]]*supplier_code[[:space:]]*\)',
    'on conflict on constraint suppliers_supplier_code_key',
    'gi'
  );
  patched_definition := regexp_replace(
    patched_definition,
    'on[[:space:]]+conflict[[:space:]]*\([[:space:]]*supplier_id[[:space:]]*,[[:space:]]*item_id[[:space:]]*\)',
    'on conflict on constraint supplier_uniform_items_pkey',
    'gi'
  );
  patched_definition := regexp_replace(
    patched_definition,
    'on[[:space:]]+conflict[[:space:]]*\([[:space:]]*code[[:space:]]*\)',
    'on conflict on constraint institutions_code_key',
    'gi'
  );

  if patched_definition = current_definition
     and position('on conflict on constraint' in lower(current_definition)) = 0 then
    raise exception using
      errcode = '55000',
      message = 'No master-data ON CONFLICT targets were found to patch';
  end if;

  execute patched_definition;
end;
$repair$;

commit;

select
  p.oid::regprocedure as function_signature,
  md5(pg_get_functiondef(p.oid)) as definition_md5,
  lower(pg_get_functiondef(p.oid)) like '%on conflict on constraint uniform_items_item_code_key%' as uses_named_item_constraint,
  lower(pg_get_functiondef(p.oid)) like '%on conflict on constraint operation_commands_operation_code_idempotency_key_key%' as uses_named_command_constraint
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.oid = 'public.apply_master_import(text,text,jsonb,text,text)'::regprocedure;
