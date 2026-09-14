-- A 10 MB verified upload can expand when each bounded row is encoded as
-- JSONB (quotes, escaped control characters, normalized values and diffs).
-- Keep the upload limit unchanged, but leave enough headroom for the durable
-- chunk envelope so valid files are not rejected after parsing.
-- This is a forward-safe function replacement: existing grants and rows are
-- preserved, and no import history is rewritten.
do $migration$
declare
  function_sql text;
  old_guard text := 'pg_column_size(p_rows) > 10000000';
  new_guard text := 'pg_column_size(p_rows) > 25000000';
begin
  select pg_get_functiondef(
    'public.complete_import_chunk(uuid,text,bigint,bigint,jsonb,text,text)'::regprocedure
  ) into function_sql;
  if function_sql is null or position(old_guard in function_sql) = 0 then
    raise exception 'complete_import_chunk payload guard was not found';
  end if;
  execute replace(function_sql, old_guard, new_guard);
end;
$migration$;
