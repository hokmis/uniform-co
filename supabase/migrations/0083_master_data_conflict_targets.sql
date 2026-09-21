begin;

-- The master-data RPCs use these business keys as ON CONFLICT targets. Keep the
-- migration fail-closed so an existing duplicate cannot be silently hidden by
-- adding a partial or otherwise weaker index.
do $migration$
begin
  if exists (
    select 1
    from public.operation_commands
    group by operation_code, idempotency_key
    having count(*) > 1
  ) then
    raise exception using
      errcode = '23505',
      message = 'Duplicate operation_commands(operation_code, idempotency_key) must be resolved before 0083';
  end if;

  if exists (
    select 1
    from public.institutions
    group by code
    having count(*) > 1
  ) then
    raise exception using
      errcode = '23505',
      message = 'Duplicate institutions.code must be resolved before 0083';
  end if;

  if exists (
    select 1
    from public.departments
    group by institution_id, code
    having count(*) > 1
  ) then
    raise exception using
      errcode = '23505',
      message = 'Duplicate departments(institution_id, code) must be resolved before 0083';
  end if;

  if exists (
    select 1
    from public.uniform_items
    group by item_code
    having count(*) > 1
  ) then
    raise exception using
      errcode = '23505',
      message = 'Duplicate uniform_items.item_code must be resolved before 0083';
  end if;

  if exists (
    select 1
    from public.suppliers
    group by supplier_code
    having count(*) > 1
  ) then
    raise exception using
      errcode = '23505',
      message = 'Duplicate suppliers.supplier_code must be resolved before 0083';
  end if;

  if exists (
    select 1
    from public.supplier_uniform_items
    group by supplier_id, item_id
    having count(*) > 1
  ) then
    raise exception using
      errcode = '23505',
      message = 'Duplicate supplier_uniform_items(supplier_id, item_id) must be resolved before 0083';
  end if;
end;
$migration$;

-- IF NOT EXISTS makes this forward migration safe to re-run after a timeout.
-- A full unique index is intentional: a partial active-only index cannot be
-- inferred by ON CONFLICT and would allow duplicate inactive business keys.
create unique index if not exists operation_commands_operation_idempotency_conflict_idx
  on public.operation_commands (operation_code, idempotency_key);

create unique index if not exists institutions_code_conflict_idx
  on public.institutions (code);

create unique index if not exists departments_institution_code_conflict_idx
  on public.departments (institution_id, code);

create unique index if not exists uniform_items_item_code_conflict_idx
  on public.uniform_items (item_code);

create unique index if not exists suppliers_supplier_code_conflict_idx
  on public.suppliers (supplier_code);

create unique index if not exists supplier_uniform_items_supplier_item_conflict_idx
  on public.supplier_uniform_items (supplier_id, item_id);

commit;
