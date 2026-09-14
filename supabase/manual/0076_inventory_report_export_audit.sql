-- 若 production 已依序套用 migration，這個檔案不需要再次執行。
-- 若是以 Supabase SQL Editor 手動維護，請在 0031 audit_events 已存在後執行。

create or replace function public.record_report_export(
  p_report_name text,
  p_row_count integer,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  report_name text := btrim(coalesce(p_report_name, ''));
  event_id uuid;
begin
  current_account := private.current_account_id();
  if auth.uid() is null
     or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null then
    raise exception using errcode = '42501', message = 'Authenticated account is required';
  end if;
  if report_name not in ('v_item_availability', 'v_inventory_history')
     or p_row_count is null or p_row_count < 0 or p_row_count > 2000
     or btrim(coalesce(p_idempotency_key, '')) = ''
     or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'Report export fields are invalid';
  end if;
  if not (private.has_role('HR') or private.has_role('WAREHOUSE')) then
    raise exception using errcode = '42501', message = 'Role cannot export inventory reports';
  end if;
  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('EXPORT_REPORT_' || report_name, p_idempotency_key, p_request_fingerprint, current_account)
  on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'EXPORT_REPORT_' || report_name and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' and command_row.result_entity_id is not null then
      return command_row.result_entity_id;
    end if;
    raise exception using errcode = '40001', message = 'Report export audit is already in progress or failed';
  end if;
  event_id := private.append_audit_event(
    current_account,
    'REPORT_EXPORTED',
    report_name,
    null,
    null,
    jsonb_build_object(
      'row_count', p_row_count,
      'request_fingerprint', left(btrim(p_request_fingerprint), 255)
    ),
    null,
    null,
    null,
    jsonb_build_object('source', 'inventory-management')
  );
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'audit_events', result_entity_id = event_id, succeeded_at = now()
  where id = command_row.id;
  return event_id;
end;
$$;

revoke all on function public.record_report_export(text, integer, text, text) from public, anon;
grant execute on function public.record_report_export(text, integer, text, text) to authenticated;
