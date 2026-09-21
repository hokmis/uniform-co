begin;

-- Department editor requests carry both the institution code and, when the
-- selector came from the current catalog, the institution id. Resolve the
-- parent from the id first and retain the code fallback for older import
-- files. This keeps a stale or malformed selector from reaching the
-- departments NOT NULL constraint as a null institution_id.
do $migration$
declare
  current_definition text;
  patched_definition text;
  department_lookup text := 'select id into target_id from public.institutions where code = btrim(row_value ->> ''institutionCode'');';
  department_lookup_replacement text := $replacement$
      target_id := null;
      if nullif(btrim(row_value ->> 'institutionId'), '') is not null then
        begin
          select i.id into target_id
          from public.institutions i
          where i.id = (row_value ->> 'institutionId')::uuid
            and i.code = btrim(row_value ->> 'institutionCode')
            and i.is_active;
        exception when invalid_text_representation then
          target_id := null;
        end;
      end if;
      if target_id is null then
        select i.id into target_id
        from public.institutions i
        where i.code = btrim(row_value ->> 'institutionCode')
          and i.is_active;
      end if;
      if target_id is null then
        raise exception using
          errcode = '23503',
          message = 'Department institution could not be resolved';
      end if;$replacement$;
begin
  select pg_get_functiondef(
    'public.apply_master_import(text,text,jsonb,text,text)'::regprocedure
  ) into current_definition;

  if current_definition is null then
    raise exception using
      errcode = '42883',
      message = 'public.apply_master_import(text,text,jsonb,text,text) was not found';
  end if;

  if position('row_value ->> ''institutionId''' in current_definition) = 0 then
    patched_definition := replace(current_definition, department_lookup, department_lookup_replacement);
    if patched_definition = current_definition then
      raise exception using
        errcode = '55000',
        message = 'Could not patch department institution resolution in apply_master_import';
    end if;
    execute patched_definition;
  end if;
end;
$migration$;

commit;
