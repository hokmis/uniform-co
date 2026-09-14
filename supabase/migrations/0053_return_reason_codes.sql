create table public.return_reason_codes (
  code text primary key check (btrim(code) <> '' and code = upper(btrim(code))),
  label text not null check (btrim(label) <> ''),
  is_active boolean not null default true,
  sort_order integer not null default 0
);

insert into public.return_reason_codes(code, label, is_active, sort_order) values
  ('RESIGNATION', '離職', true, 10),
  ('SIZE_MISMATCH', '尺寸不合', true, 20),
  ('DAMAGE', '破損汰換', true, 30),
  ('REPLACEMENT', '換發', true, 40),
  ('OTHER', '其他', true, 90),
  ('LEGACY', '歷史退回資料', false, 999)
on conflict (code) do nothing;

alter table public.return_notes
  add column if not exists return_date date not null default current_date,
  add column if not exists reason_code text not null default 'LEGACY'
    references public.return_reason_codes(code);

create or replace function private.require_active_return_reason()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  if new.reason_code is null or not exists (
    select 1 from public.return_reason_codes r
    where r.code = new.reason_code and r.is_active
  ) then
    raise exception 'An active return reason code is required';
  end if;
  if new.return_date is null then
    raise exception 'Return date is required';
  end if;
  return new;
end;
$$;

create trigger return_notes_reason_guard
before insert or update on public.return_notes
for each row execute function private.require_active_return_reason();

alter table public.return_reason_codes enable row level security;
revoke all on table public.return_reason_codes from public, anon, authenticated;
grant select on public.return_reason_codes to authenticated;
create policy return_reason_codes_read on public.return_reason_codes
  for select to authenticated using (
    private.has_role('SYSTEM_ADMIN') or (is_active and (private.has_role('HR') or private.has_role('WAREHOUSE')))
  );

create or replace function public.maintain_return_reason_code(
  p_code text,
  p_label text,
  p_is_active boolean,
  p_sort_order integer,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.return_reason_codes
language plpgsql security definer set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  reason_row public.return_reason_codes;
  reason_code text;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('SYSTEM_ADMIN') then
    raise exception using errcode = '42501', message = 'SYSTEM_ADMIN role is required';
  end if;
  reason_code := upper(btrim(coalesce(p_code, '')));
  if reason_code = '' or btrim(coalesce(p_label, '')) = ''
     or btrim(coalesce(p_idempotency_key, '')) = ''
     or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'reason code, label, idempotency key and fingerprint are required';
  end if;
  insert into public.operation_commands(operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('MAINTAIN_RETURN_REASON_CODE', p_idempotency_key, p_request_fingerprint, current_account)
  on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'MAINTAIN_RETURN_REASON_CODE' and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' then
      select * into reason_row from public.return_reason_codes where code = reason_code;
      return reason_row;
    end if;
    raise exception using errcode = '40001', message = 'return reason maintenance is already in progress or failed';
  end if;
  insert into public.return_reason_codes(code, label, is_active, sort_order)
  values (reason_code, left(btrim(p_label), 120), coalesce(p_is_active, true), coalesce(p_sort_order, 0))
  on conflict (code) do update set label = excluded.label, is_active = excluded.is_active, sort_order = excluded.sort_order
  returning * into reason_row;
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'return_reason_codes', succeeded_at = now()
  where id = command_row.id;
  return reason_row;
end;
$$;

-- The legacy creator has no reason-code/date parameters.  Existing historical
-- rows retain LEGACY values, but new drafts must use the v2 RPC below.
revoke all on function public.create_return_note_draft(text, uuid, text, text, jsonb, text, text) from public, anon, authenticated;
revoke all on function public.maintain_return_reason_code(text, text, boolean, integer, text, text) from public, anon;
grant execute on function public.maintain_return_reason_code(text, text, boolean, integer, text, text) to authenticated;
create or replace function public.create_return_note_draft(
  p_return_no text,
  p_original_hr_request_id uuid,
  p_return_date date,
  p_reason_code text,
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
     or p_return_date is null
     or not exists (select 1 from public.return_reason_codes r where r.code = upper(btrim(coalesce(p_reason_code, ''))) and r.is_active)
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
    'CREATE_RETURN_NOTE_DRAFT_V2', p_idempotency_key, p_request_fingerprint, current_account
  ) on conflict (operation_code, idempotency_key) do nothing
  returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'CREATE_RETURN_NOTE_DRAFT_V2' and idempotency_key = p_idempotency_key
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
    return_no, original_hr_request_id, return_date, reason_code, reason, note, created_by
  ) values (
    left(btrim(p_return_no), 80), p_original_hr_request_id, p_return_date,
    upper(btrim(p_reason_code)), left(btrim(p_reason), 1000),
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



revoke all on function public.create_return_note_draft(text, uuid, date, text, text, text, jsonb, text, text) from public, anon;
grant execute on function public.create_return_note_draft(text, uuid, date, text, text, text, jsonb, text, text) to authenticated;
