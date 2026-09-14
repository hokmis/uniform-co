-- Return drafts derive identity and snapshots from shipped issue lines.
-- Callers can provide only an original line id and quantity; they cannot forge
-- employee/item or historical snapshot fields.

create or replace function public.create_return_note_draft(
  p_return_no text,
  p_original_hr_request_id uuid,
  p_reason text,
  p_note text,
  p_lines jsonb,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.return_notes
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  note_row public.return_notes;
  request_row public.hr_requests;
  line_value jsonb;
  source_line public.hr_issue_lines;
  item_id_row record;
  item_ids uuid[];
  line_count integer;
  quantity bigint;
  line_no integer := 0;
begin
  current_account := private.current_account_id();
  if auth.uid() is null
     or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null
     or not private.has_role('HR') then
    raise exception using errcode = '42501', message = 'HR role is required';
  end if;
  if btrim(coalesce(p_return_no, '')) = ''
     or p_original_hr_request_id is null
     or btrim(coalesce(p_reason, '')) = ''
     or p_lines is null
     or jsonb_typeof(p_lines) <> 'array'
     or btrim(coalesce(p_idempotency_key, '')) = ''
     or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'Return draft fields are invalid';
  end if;
  line_count := jsonb_array_length(p_lines);
  if line_count = 0 or line_count > 1000 or pg_column_size(p_lines) > 10000000 then
    raise exception 'Return draft line limits exceeded';
  end if;
  for line_value in select value from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(line_value) <> 'object'
       or coalesce(line_value ->> 'originalIssueLineId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or coalesce(line_value ->> 'quantity', '') !~ '^[1-9][0-9]{0,17}$' then
      raise exception 'Invalid return line';
    end if;
  end loop;
  if exists (
    select 1 from (
      select (value ->> 'originalIssueLineId')::uuid as issue_line_id
      from jsonb_array_elements(p_lines)
    ) requested group by issue_line_id having count(*) > 1
  ) then
    raise exception 'A return note cannot contain the same issue line more than once';
  end if;

  insert into public.operation_commands (
    operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id
  ) values (
    'CREATE_RETURN_NOTE_DRAFT', p_idempotency_key, p_request_fingerprint, current_account
  ) on conflict (operation_code, idempotency_key) do nothing
  returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'CREATE_RETURN_NOTE_DRAFT' and idempotency_key = p_idempotency_key
      for update;
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' and command_row.result_entity_id is not null then
      select * into note_row from public.return_notes where id = command_row.result_entity_id;
      return note_row;
    end if;
    raise exception using errcode = '40001', message = 'Return draft is already in progress or failed';
  end if;

  select coalesce(array_agg(source.item_id order by source.item_id), '{}'::uuid[])
    into item_ids
  from (
    select distinct l.item_id
    from public.hr_issue_lines l
    where l.request_id = p_original_hr_request_id
      and l.id in (
        select (value ->> 'originalIssueLineId')::uuid
        from jsonb_array_elements(p_lines)
      )
  ) source;
  if cardinality(item_ids) = 0 then raise exception 'Return note needs valid original issue lines'; end if;
  insert into public.inventory_item_locks (item_id)
  select item_id from unnest(item_ids) as requested(item_id) order by item_id
  on conflict (item_id) do nothing;
  for item_id_row in select item_id from unnest(item_ids) as requested(item_id) order by item_id loop
    perform 1 from public.inventory_item_locks where item_id = item_id_row.item_id for update;
  end loop;
  select * into request_row from public.hr_requests
  where id = p_original_hr_request_id for update;
  if request_row.id is null or request_row.status <> 'SHIPPED' then
    raise exception 'Returns require a SHIPPED HR request';
  end if;
  insert into public.return_notes (
    return_no, original_hr_request_id, reason, note, created_by
  ) values (
    left(btrim(p_return_no), 80), p_original_hr_request_id, left(btrim(p_reason), 1000),
    left(nullif(btrim(coalesce(p_note, '')), ''), 2000), current_account
  ) returning * into note_row;

  for line_value in select value from jsonb_array_elements(p_lines) loop
    quantity := (line_value ->> 'quantity')::bigint;
    select * into source_line from public.hr_issue_lines
    where request_id = p_original_hr_request_id
      and id = (line_value ->> 'originalIssueLineId')::uuid
    for update;
    if source_line.id is null then raise exception 'Original issue line does not belong to the selected request'; end if;
    line_no := line_no + 1;
    insert into public.return_lines (
      return_note_id, original_hr_request_id, original_issue_line_id,
      line_no, employee_id, item_id, quantity,
      employee_no_snapshot, employee_name_snapshot, item_code_snapshot,
      item_name_snapshot, size_snapshot, unit_snapshot
    ) values (
      note_row.id, p_original_hr_request_id, source_line.id, line_no,
      source_line.employee_id, source_line.item_id, quantity,
      source_line.employee_no_snapshot, source_line.employee_name_snapshot,
      source_line.item_code_snapshot, source_line.item_name_snapshot,
      source_line.size_snapshot, source_line.unit_snapshot
    );
  end loop;
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'return_notes',
      result_entity_id = note_row.id, succeeded_at = now()
  where id = command_row.id;
  return note_row;
end;
$$;

revoke all on function public.create_return_note_draft(text, uuid, text, text, jsonb, text, text) from public, anon;
grant execute on function public.create_return_note_draft(text, uuid, text, text, jsonb, text, text) to authenticated;
revoke insert, update on public.return_notes, public.return_lines from authenticated;

-- Preserve the same item/source-line lock order when an existing draft is edited.
create or replace function public.update_return_note_draft(
  p_return_note_id uuid,
  p_reason text,
  p_note text,
  p_lines jsonb,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.return_notes
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid := private.current_account_id();
  command_row public.operation_commands;
  note_row public.return_notes;
  line_value jsonb;
  source_line public.hr_issue_lines;
  item_id_row record;
  item_ids uuid[];
  line_no integer := 0;
begin
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('HR') then
    raise exception using errcode = '42501', message = 'HR role is required';
  end if;
  if p_return_note_id is null or btrim(coalesce(p_reason, '')) = ''
     or p_lines is null or jsonb_typeof(p_lines) <> 'array'
     or jsonb_array_length(p_lines) = 0 or jsonb_array_length(p_lines) > 1000
     or pg_column_size(p_lines) > 10000000
     or btrim(coalesce(p_idempotency_key, '')) = ''
     or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'Return update fields are invalid';
  end if;
  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('UPDATE_RETURN_NOTE_DRAFT', p_idempotency_key, p_request_fingerprint, current_account)
  on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'UPDATE_RETURN_NOTE_DRAFT' and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' then select * into note_row from public.return_notes where id = command_row.result_entity_id; return note_row; end if;
    raise exception using errcode = '40001', message = 'Return update is already in progress or failed';
  end if;
  select * into note_row from public.return_notes where id = p_return_note_id and created_by = current_account for update;
  if note_row.id is null or note_row.status <> 'DRAFT' then raise exception 'Only DRAFT return notes can be updated'; end if;
  select coalesce(array_agg(l.item_id order by l.item_id), '{}'::uuid[]) into item_ids
  from public.hr_issue_lines l
  where l.request_id = note_row.original_hr_request_id and l.id in (
    select (value ->> 'originalIssueLineId')::uuid from jsonb_array_elements(p_lines)
  );
  insert into public.inventory_item_locks (item_id) select item_id from unnest(item_ids) requested(item_id) order by item_id on conflict do nothing;
  for item_id_row in select item_id from unnest(item_ids) requested(item_id) order by item_id loop
    perform 1 from public.inventory_item_locks where item_id = item_id_row.item_id for update;
  end loop;
  select * into note_row from public.return_notes where id = p_return_note_id for update;
  delete from public.return_lines where return_note_id = p_return_note_id;
  for line_value in select value from jsonb_array_elements(p_lines) loop
    select * into source_line from public.hr_issue_lines where request_id = note_row.original_hr_request_id and id = (line_value ->> 'originalIssueLineId')::uuid for update;
    if source_line.id is null then raise exception 'Original issue line does not belong to the return request'; end if;
    line_no := line_no + 1;
    insert into public.return_lines (return_note_id, original_hr_request_id, original_issue_line_id, line_no, employee_id, item_id, quantity, employee_no_snapshot, employee_name_snapshot, item_code_snapshot, item_name_snapshot, size_snapshot, unit_snapshot)
    values (note_row.id, note_row.original_hr_request_id, source_line.id, line_no, source_line.employee_id, source_line.item_id, (line_value ->> 'quantity')::bigint, source_line.employee_no_snapshot, source_line.employee_name_snapshot, source_line.item_code_snapshot, source_line.item_name_snapshot, source_line.size_snapshot, source_line.unit_snapshot);
  end loop;
  update public.return_notes set reason = left(btrim(p_reason), 1000), note = left(nullif(btrim(coalesce(p_note, '')), ''), 2000) where id = p_return_note_id returning * into note_row;
  update public.operation_commands set status = 'SUCCEEDED', result_entity_type = 'return_notes', result_entity_id = p_return_note_id, succeeded_at = now() where id = command_row.id;
  return note_row;
end;
$$;

revoke all on function public.update_return_note_draft(uuid, text, text, jsonb, text, text) from public, anon;
grant execute on function public.update_return_note_draft(uuid, text, text, jsonb, text, text) to authenticated;
