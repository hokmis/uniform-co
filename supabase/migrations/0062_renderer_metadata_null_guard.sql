-- Forward-safe renderer finalize hardening.  The original finalize functions
-- used ordinary <> comparisons; a missing Storage size metadata value becomes
-- NULL and could therefore bypass the mismatch check under PL/pgSQL's
-- three-valued boolean rules.  Empty metadata keys must also fall through to
-- the alternate user_metadata field.
do $migration$
declare
  function_sql text;
  old_select text := 'select lower(coalesce(metadata->>''sha256'', user_metadata->>''sha256'','''')), case when coalesce(metadata->>''size'', user_metadata->>''size'') ~ ''^[0-9]+$'' then coalesce(metadata->>''size'', user_metadata->>''size'')::bigint end';
  old_select_spaced text := 'select lower(coalesce(metadata ->> ''sha256'', user_metadata ->> ''sha256'', '''')), case when coalesce(metadata ->> ''size'', user_metadata ->> ''size'') ~ ''^[0-9]+$'' then coalesce(metadata ->> ''size'', user_metadata ->> ''size'')::bigint end';
  new_select text := 'select lower(coalesce(nullif(metadata->>''sha256'',''''), nullif(user_metadata->>''sha256'',''''), '''')), case when coalesce(nullif(metadata->>''size'',''''), nullif(user_metadata->>''size'','''')) ~ ''^[0-9]+$'' then coalesce(nullif(metadata->>''size'',''''), nullif(user_metadata->>''size'',''''))::bigint end';
  new_select_spaced text := 'select lower(coalesce(nullif(metadata ->> ''sha256'', ''''), nullif(user_metadata ->> ''sha256'', ''''), '''')), case when coalesce(nullif(metadata ->> ''size'', ''''), nullif(user_metadata ->> ''size'', '''')) ~ ''^[0-9]+$'' then coalesce(nullif(metadata ->> ''size'', ''''), nullif(user_metadata ->> ''size'', ''''))::bigint end';
  old_guard text := 'if not found or h<>lower(p_payload_sha256) or n<>p_payload_size_bytes then';
  old_guard_spaced text := 'if not found or h <> lower(p_payload_sha256) or n <> p_payload_size_bytes then';
  new_guard text := 'if not found or h is distinct from lower(p_payload_sha256) or n is distinct from p_payload_size_bytes then';
begin
  foreach function_sql in array array[
    pg_get_functiondef('public.finalize_document_render_attempt(uuid,text,bigint,text,text,bigint)'::regprocedure),
    pg_get_functiondef('public.finalize_erp_render_attempt(uuid,text,bigint,text,text,bigint)'::regprocedure)
  ] loop
    if function_sql is null then
      raise exception 'renderer finalize metadata guard was not found';
    end if;
    if position(old_select in function_sql) > 0 then
      function_sql := replace(function_sql, old_select, new_select);
    elsif position(old_select_spaced in function_sql) > 0 then
      function_sql := replace(function_sql, old_select_spaced, new_select_spaced);
    else
      raise exception 'renderer finalize metadata select was not found';
    end if;
    if position(old_guard in function_sql) > 0 then
      function_sql := replace(function_sql, old_guard, new_guard);
    elsif position(old_guard_spaced in function_sql) > 0 then
      function_sql := replace(function_sql, old_guard_spaced, new_guard);
    else
      raise exception 'renderer finalize metadata comparison was not found';
    end if;
    execute function_sql;
  end loop;
end;
$migration$;
