-- 0122 removes duplicate unique indexes left by 0083 after the named
-- constraint repair in 0084 is active.
--
-- Run this file only in the same Supabase project used by the website, after
-- verifying 0084 (or the equivalent named-constraint RPC repair) is complete.
-- It fails closed when any required constraint or RPC target is missing.

begin;

do $migration$
declare
  missing_constraints text;
  current_definition text;
  constraint_row record;
begin
  select string_agg(expected.constraint_name, ', ' order by expected.constraint_name)
  into missing_constraints
  from (
    values
      ('operation_commands'::text, 'operation_commands_operation_code_idempotency_key_key'::text),
      ('institutions'::text, 'institutions_code_key'::text),
      ('departments'::text, 'departments_institution_id_code_key'::text),
      ('uniform_items'::text, 'uniform_items_item_code_key'::text),
      ('suppliers'::text, 'suppliers_supplier_code_key'::text),
      ('supplier_uniform_items'::text, 'supplier_uniform_items_pkey'::text)
  ) as expected(table_name, constraint_name)
  where not exists (
    select 1
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = expected.table_name
      and c.conname = expected.constraint_name
      and c.contype in ('p', 'u')
  );

  if missing_constraints is not null then
    raise exception using
      errcode = '55000',
      message = '0122 requires named master-data constraints: ' || missing_constraints;
  end if;

  select pg_get_functiondef(
    'public.apply_master_import(text,text,jsonb,text,text)'::regprocedure
  )
  into current_definition;

  if current_definition is null then
    raise exception using
      errcode = '42883',
      message = '0122 requires public.apply_master_import(text,text,jsonb,text,text)';
  end if;

  for constraint_row in
    select constraint_name
    from (
      values
        ('operation_commands_operation_code_idempotency_key_key'::text),
        ('institutions_code_key'::text),
        ('departments_institution_id_code_key'::text),
        ('uniform_items_item_code_key'::text),
        ('suppliers_supplier_code_key'::text),
        ('supplier_uniform_items_pkey'::text)
    ) as required(constraint_name)
  loop
    if position(
      lower('on conflict on constraint ' || constraint_row.constraint_name)
      in lower(current_definition)
    ) = 0 then
      raise exception using
        errcode = '55000',
        message = '0122 requires apply_master_import to use named constraint ' || constraint_row.constraint_name;
    end if;
  end loop;
end;
$migration$;

drop index if exists public.operation_commands_operation_idempotency_conflict_idx;
drop index if exists public.institutions_code_conflict_idx;
drop index if exists public.departments_institution_code_conflict_idx;
drop index if exists public.uniform_items_item_code_conflict_idx;
drop index if exists public.suppliers_supplier_code_conflict_idx;
drop index if exists public.supplier_uniform_items_supplier_item_conflict_idx;

commit;
