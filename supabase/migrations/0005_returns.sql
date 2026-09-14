-- Employee returns are new immutable transactions; original issue lines stay unchanged.

create table public.return_notes (
  id uuid primary key default gen_random_uuid(),
  return_no text not null unique check (btrim(return_no) <> ''),
  original_hr_request_id uuid not null references public.hr_requests(id),
  status text not null default 'DRAFT' check (status in ('DRAFT', 'POSTED')),
  reason text not null check (btrim(reason) <> ''),
  created_by uuid not null references public.app_accounts(id),
  posted_at timestamptz,
  posted_by uuid references public.app_accounts(id),
  note text,
  unique (id, original_hr_request_id)
);

create table public.return_lines (
  id uuid primary key default gen_random_uuid(),
  return_note_id uuid not null,
  line_no integer not null check (line_no > 0),
  original_hr_request_id uuid not null,
  original_issue_line_id uuid not null,
  employee_id uuid not null references public.employees(id),
  item_id uuid not null references public.uniform_items(id),
  quantity bigint not null check (quantity > 0),
  employee_no_snapshot text,
  employee_name_snapshot text,
  item_code_snapshot text,
  item_name_snapshot text,
  size_snapshot text,
  unit_snapshot text,
  unique (return_note_id, original_issue_line_id),
  unique (return_note_id, line_no),
  unique (return_note_id, id),
  foreign key (return_note_id, original_hr_request_id)
    references public.return_notes(id, original_hr_request_id),
  foreign key (original_hr_request_id, original_issue_line_id)
    references public.hr_issue_lines(request_id, id)
);

create or replace function private.prevent_posted_return_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  if tg_table_name = 'return_notes' then
    if old.status = 'POSTED' then
      raise exception 'Posted return notes are immutable';
    end if;
    if old.original_hr_request_id <> new.original_hr_request_id then
      raise exception 'A return note cannot move to another HR request';
    end if;
  elsif exists (
    select 1 from public.return_notes r
    where r.id = old.return_note_id and r.status = 'POSTED'
  ) then
    raise exception 'Posted return lines are immutable';
  end if;
  return new;
end;
$$;

create trigger return_notes_immutable_guard
before update or delete on public.return_notes
for each row execute function private.prevent_posted_return_mutation();
create trigger return_lines_immutable_guard
before update or delete on public.return_lines
for each row execute function private.prevent_posted_return_mutation();

create or replace function private.validate_return_line_source()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  source_line public.hr_issue_lines;
begin
  select * into source_line from public.hr_issue_lines
  where request_id = new.original_hr_request_id and id = new.original_issue_line_id;
  if source_line.id is null then
    raise exception 'Original issue line does not belong to the return request';
  end if;
  if new.employee_id <> source_line.employee_id or new.item_id <> source_line.item_id then
    raise exception 'Return employee and item must match the original issue line';
  end if;
  if new.quantity > source_line.quantity then
    raise exception 'Return quantity cannot exceed the original issue quantity';
  end if;
  new.employee_no_snapshot := source_line.employee_no_snapshot;
  new.employee_name_snapshot := source_line.employee_name_snapshot;
  new.item_code_snapshot := source_line.item_code_snapshot;
  new.item_name_snapshot := source_line.item_name_snapshot;
  new.size_snapshot := source_line.size_snapshot;
  new.unit_snapshot := source_line.unit_snapshot;
  return new;
end;
$$;

create trigger return_line_source_guard
before insert or update on public.return_lines
for each row execute function private.validate_return_line_source();

create or replace function public.post_return_note(
  p_return_note_id uuid,
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
  line_row record;
  item_id_row record;
  item_ids uuid[];
  current_item_ids uuid[];
  hr_warehouse_id uuid;
  balance_quantity bigint;
  posted_total bigint;
  effective_issued bigint;
  posting_id uuid;
  line_no integer := 0;
  result_row public.return_notes;
begin
  current_account := private.current_account_id();
  if auth.uid() is null
     or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null
     or not private.has_role('HR') then
    raise exception using errcode = '42501', message = 'HR role is required';
  end if;
  if btrim(coalesce(p_idempotency_key, '')) = ''
     or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'idempotency_key and request_fingerprint are required';
  end if;
  insert into public.operation_commands (
    operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id
  ) values (
    'POST_RETURN_NOTE', p_idempotency_key, p_request_fingerprint, current_account
  ) on conflict (operation_code, idempotency_key) do nothing
  returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'POST_RETURN_NOTE'
      and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' and command_row.result_entity_id = p_return_note_id then
      select * into result_row from public.return_notes where id = p_return_note_id;
      return result_row;
    end if;
    raise exception using errcode = '40001', message = 'return POST is already in progress or failed';
  end if;

  select coalesce(array_agg(item_id order by item_id), '{}'::uuid[])
    into item_ids
  from (
    select distinct item_id from public.return_lines where return_note_id = p_return_note_id
  ) requested_items;
  if cardinality(item_ids) = 0 then
    raise exception 'Return note needs at least one item';
  end if;
  insert into public.inventory_item_locks (item_id)
  select item_id from unnest(item_ids) as requested(item_id) order by item_id
  on conflict (item_id) do nothing;
  for item_id_row in
    select item_id from unnest(item_ids) as requested(item_id) order by item_id
  loop
    perform 1 from public.inventory_item_locks where item_id = item_id_row.item_id for update;
  end loop;

  select * into note_row from public.return_notes where id = p_return_note_id for update;
  if note_row.id is null or note_row.status <> 'DRAFT' then
    raise exception 'Only DRAFT return notes can be posted';
  end if;
  select * into request_row from public.hr_requests
  where id = note_row.original_hr_request_id for update;
  if request_row.id is null or request_row.status <> 'SHIPPED' then
    raise exception 'Returns require a SHIPPED HR request';
  end if;
  select coalesce(array_agg(item_id order by item_id), '{}'::uuid[])
    into current_item_ids
  from (
    select distinct item_id from public.return_lines where return_note_id = p_return_note_id
  ) current_items;
  if current_item_ids is distinct from item_ids then
    raise exception using errcode = '40001', message = 'Return item set changed while locking; retry';
  end if;
  for item_id_row in
    select item_id from unnest(item_ids) as requested(item_id) order by item_id
  loop
    perform 1 from public.return_lines
    where return_note_id = p_return_note_id and item_id = item_id_row.item_id for update;
  end loop;

  select id into hr_warehouse_id from public.warehouses where purpose = 'HR' and is_active;
  if hr_warehouse_id is null then
    raise exception 'An active HR warehouse is required';
  end if;
  insert into public.inventory_balances (warehouse_id, item_id)
  select hr_warehouse_id, item_id from unnest(item_ids) as requested(item_id)
  on conflict (warehouse_id, item_id) do nothing;
  for item_id_row in
    select item_id from unnest(item_ids) as requested(item_id) order by item_id
  loop
    perform 1 from public.inventory_balances b
    where b.warehouse_id = hr_warehouse_id and b.item_id = item_id_row.item_id
    order by b.item_id, b.warehouse_id for update;
  end loop;

  for line_row in
    select l.* from public.return_lines l
    where l.return_note_id = p_return_note_id order by l.item_id, l.original_issue_line_id
  loop
    select coalesce(sum(r.quantity), 0) into posted_total
    from public.return_lines r
    join public.return_notes rn on rn.id = r.return_note_id
    where rn.status = 'POSTED'
      and r.original_issue_line_id = line_row.original_issue_line_id;
    select quantity into effective_issued
    from public.hr_issue_lines where id = line_row.original_issue_line_id;
    if posted_total + line_row.quantity > effective_issued then
      raise exception 'Return quantity exceeds remaining issued quantity';
    end if;
  end loop;

  insert into public.inventory_postings
    (idempotency_key, posting_kind, source_entity_id, posted_by)
  values (p_idempotency_key, 'RETURN', p_return_note_id, current_account)
  returning id into posting_id;
  for line_row in
    select l.* from public.return_lines l
    where l.return_note_id = p_return_note_id order by l.item_id, l.original_issue_line_id
  loop
    line_no := line_no + 1;
    insert into public.inventory_ledger_entries
      (posting_id, line_no, warehouse_id, item_id, movement_kind, quantity_delta, occurred_on)
    values (posting_id, line_no, hr_warehouse_id, line_row.item_id,
      'RETURN_IN', line_row.quantity, current_date);
    update public.inventory_balances
    set on_hand_quantity = on_hand_quantity + line_row.quantity,
        version = version + 1, last_posting_id = posting_id, updated_at = now()
    where warehouse_id = hr_warehouse_id and item_id = line_row.item_id;
  end loop;
  update public.return_notes
  set status = 'POSTED', posted_at = now(), posted_by = current_account
  where id = p_return_note_id
  returning * into result_row;
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'return_notes',
      result_entity_id = p_return_note_id, succeeded_at = now()
  where id = command_row.id;
  return result_row;
end;
$$;

revoke all on function public.post_return_note(uuid, text, text) from public, anon;
grant execute on function public.post_return_note(uuid, text, text) to authenticated;

alter table public.return_notes enable row level security;
alter table public.return_lines enable row level security;
create policy return_notes_read on public.return_notes
  for select to authenticated using (private.has_role('HR') or private.has_role('WAREHOUSE'));
create policy return_lines_read on public.return_lines
  for select to authenticated using (private.has_role('HR') or private.has_role('WAREHOUSE'));
create policy return_notes_draft_insert on public.return_notes
  for insert to authenticated with check (
    private.has_role('HR') and created_by = private.current_account_id() and status = 'DRAFT'
  );
create policy return_notes_draft_update on public.return_notes
  for update to authenticated using (
    private.has_role('HR') and created_by = private.current_account_id() and status = 'DRAFT'
  ) with check (
    private.has_role('HR') and created_by = private.current_account_id() and status = 'DRAFT'
  );
create policy return_lines_draft_insert on public.return_lines
  for insert to authenticated with check (exists (
    select 1 from public.return_notes r
    where r.id = return_note_id and r.created_by = private.current_account_id()
      and r.status = 'DRAFT' and private.has_role('HR')
  ));
create policy return_lines_draft_update on public.return_lines
  for update to authenticated using (exists (
    select 1 from public.return_notes r
    where r.id = return_note_id and r.created_by = private.current_account_id() and r.status = 'DRAFT'
  )) with check (exists (
    select 1 from public.return_notes r
    where r.id = return_note_id and r.created_by = private.current_account_id() and r.status = 'DRAFT'
  ));
revoke all on table public.return_notes, public.return_lines from public, anon, authenticated;
grant select on public.return_notes, public.return_lines to authenticated;
grant insert, update on public.return_notes, public.return_lines to authenticated;
