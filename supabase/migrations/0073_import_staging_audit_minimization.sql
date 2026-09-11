-- Keep durable import audit useful without duplicating purgeable staging payloads
-- into the permanent append-only audit log. This is forward-only: existing
-- audit_events are intentionally left unchanged for owner-reviewed remediation.

create or replace function private.import_row_audit_metadata(p_row jsonb)
returns jsonb
language sql
immutable
strict
set search_path = pg_catalog, private
as $$
  select jsonb_build_object(
    'id', p_row -> 'id',
    'batch_id', p_row -> 'batch_id',
    'row_number', p_row -> 'row_number',
    'proposed_action', p_row -> 'proposed_action',
    'target_entity_id', p_row -> 'target_entity_id',
    'applied_at', p_row -> 'applied_at'
  )
$$;

revoke all on function private.import_row_audit_metadata(jsonb) from public, anon, authenticated;

create or replace function private.audit_business_row_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  actor_id uuid;
  row_id uuid;
  before_data jsonb;
  after_data jsonb;
  client_metadata jsonb;
begin
  actor_id := private.execution_actor_id();
  if actor_id is null then
    raise exception 'An authenticated account or bound job actor is required for audit' using errcode = '42501';
  end if;

  if tg_op = 'DELETE' then
    row_id := old.id;
  else
    row_id := new.id;
  end if;

  if tg_table_schema = 'public' and tg_table_name = 'import_rows' then
    before_data := case
      when tg_op = 'INSERT' then null
      else private.import_row_audit_metadata(to_jsonb(old))
    end;
    after_data := case
      when tg_op = 'DELETE' then null
      else private.import_row_audit_metadata(to_jsonb(new))
    end;
    client_metadata := jsonb_build_object(
      'execution_channel', case when private.current_account_id() is null then 'JOB' else 'AUTHENTICATED' end,
      'payload_policy', 'IMPORT_ROW_METADATA_ONLY'
    );
  else
    before_data := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
    after_data := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
    client_metadata := jsonb_build_object(
      'execution_channel', case when private.current_account_id() is null then 'JOB' else 'AUTHENTICATED' end
    );
  end if;

  perform private.append_audit_event(
    actor_id,
    upper(tg_table_name) || '_' || lower(tg_op),
    tg_table_name,
    row_id,
    before_data,
    after_data,
    null,
    null,
    null,
    client_metadata
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function private.audit_business_row_change() from public, anon, authenticated;
