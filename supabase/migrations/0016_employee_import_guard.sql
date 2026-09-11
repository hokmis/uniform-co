-- Keep the legacy importer internal and enforce the file/payload contract at the RPC boundary.

create or replace function public.apply_employee_import_checked(
  p_source_filename text,
  p_rows jsonb,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.employee_import_batches
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  row_value jsonb;
  field_value text;
begin
  if auth.uid() is null
     or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or private.current_account_id() is null
     or not private.has_role('HR') then
    raise exception using errcode = '42501', message = 'HR role is required';
  end if;
  if btrim(coalesce(p_source_filename, '')) = ''
     or length(p_source_filename) > 255
     or p_rows is null
     or pg_column_size(p_rows) > 10000000
     or jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) = 0
     or jsonb_array_length(p_rows) > 10000 then
    raise exception 'Employee import payload exceeds the supported limits';
  end if;
  for row_value in select value from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(row_value) <> 'object'
       or (select count(*) from jsonb_object_keys(row_value)) > 50 then
      raise exception 'Every employee import row must be an object with at most 50 fields';
    end if;
    for field_value in select value from jsonb_each_text(row_value) loop
      if length(field_value) > 1000000 then
        raise exception 'Employee import cells exceed the supported limits';
      end if;
    end loop;
  end loop;
  return public.apply_employee_import(p_source_filename, p_rows, p_idempotency_key, p_request_fingerprint);
end;
$$;

revoke all on function public.apply_employee_import(text, jsonb, text, text) from public, anon, authenticated;
revoke all on function public.apply_employee_import_checked(text, jsonb, text, text) from public, anon;
grant execute on function public.apply_employee_import_checked(text, jsonb, text, text) to authenticated;
