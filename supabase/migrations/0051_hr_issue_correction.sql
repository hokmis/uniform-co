-- HR issue corrections.  A correction is a signed delta against one immutable
-- issued line; the source line remains the authoritative snapshot.

alter table public.correction_notes
  add column if not exists original_hr_request_id uuid references public.hr_requests(id);

alter table public.correction_notes
  drop constraint if exists correction_notes_correction_kind_check;
alter table public.correction_notes
  add constraint correction_notes_correction_kind_check check (
    (correction_kind = 'PURCHASE_RECEIPT'
      and original_purchase_receipt_id is not null
      and original_return_note_id is null
      and original_hr_request_id is null)
    or
    (correction_kind = 'RETURN'
      and original_purchase_receipt_id is null
      and original_return_note_id is not null
      and original_hr_request_id is null)
    or
    (correction_kind = 'HR_ISSUE'
      and original_purchase_receipt_id is null
      and original_return_note_id is null
      and original_hr_request_id is not null)
  );

alter table public.correction_notes
  add constraint correction_notes_id_hr_request_unique
  unique (id, original_hr_request_id);

create table public.issue_correction_lines (
  id uuid primary key default gen_random_uuid(),
  correction_note_id uuid not null,
  original_hr_request_id uuid not null,
  original_issue_line_id uuid not null,
  employee_id uuid not null references public.employees(id),
  item_id uuid not null references public.uniform_items(id),
  line_no integer not null default 1 check (line_no > 0),
  issue_quantity_delta bigint not null check (issue_quantity_delta <> 0),
  employee_no_snapshot text,
  employee_name_snapshot text,
  institution_id_snapshot uuid,
  institution_code_snapshot text,
  institution_name_snapshot text,
  department_id_snapshot uuid,
  department_code_snapshot text,
  department_name_snapshot text,
  item_code_snapshot text,
  item_name_snapshot text,
  unit_snapshot text,
  size_snapshot text,
  unique (correction_note_id, original_issue_line_id),
  unique (correction_note_id, line_no),
  unique (correction_note_id, id),
  foreign key (correction_note_id, original_hr_request_id)
    references public.correction_notes(id, original_hr_request_id),
  foreign key (original_hr_request_id, original_issue_line_id)
    references public.hr_issue_lines(request_id, id)
);

create or replace function private.validate_issue_correction_line()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  source_line public.hr_issue_lines;
begin
  select * into source_line
  from public.hr_issue_lines
  where request_id = new.original_hr_request_id and id = new.original_issue_line_id;
  if source_line.id is null then
    raise exception 'Original issue line does not belong to the correction source';
  end if;
  new.original_hr_request_id := source_line.request_id;
  new.employee_id := source_line.employee_id;
  new.item_id := source_line.item_id;
  new.employee_no_snapshot := source_line.employee_no_snapshot;
  new.employee_name_snapshot := source_line.employee_name_snapshot;
  new.institution_id_snapshot := source_line.institution_id_snapshot;
  new.institution_code_snapshot := source_line.institution_code_snapshot;
  new.institution_name_snapshot := source_line.institution_name_snapshot;
  new.department_id_snapshot := source_line.department_id_snapshot;
  new.department_code_snapshot := source_line.department_code_snapshot;
  new.department_name_snapshot := source_line.department_name_snapshot;
  new.item_code_snapshot := source_line.item_code_snapshot;
  new.item_name_snapshot := source_line.item_name_snapshot;
  new.unit_snapshot := source_line.unit_snapshot;
  new.size_snapshot := source_line.size_snapshot;
  return new;
end;
$$;

create trigger issue_correction_source_guard
before insert or update on public.issue_correction_lines
for each row execute function private.validate_issue_correction_line();
create trigger issue_correction_immutable_guard
before update or delete on public.issue_correction_lines
for each row execute function private.prevent_posted_correction_mutation();

create or replace function private.prevent_posted_correction_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  if tg_table_name = 'correction_notes' then
    if old.status = 'POSTED' then
      raise exception 'Posted corrections are immutable';
    end if;
    if old.correction_kind is distinct from new.correction_kind
       or old.original_purchase_receipt_id is distinct from new.original_purchase_receipt_id
       or old.original_return_note_id is distinct from new.original_return_note_id
       or old.original_hr_request_id is distinct from new.original_hr_request_id then
      raise exception 'Correction source cannot be changed';
    end if;
  elsif exists (
    select 1 from public.correction_notes c
    where c.id = old.correction_note_id and c.status = 'POSTED'
  ) then
    raise exception 'Posted correction lines are immutable';
  end if;
  return new;
end;
$$;

alter table public.correction_notes enable row level security;
alter table public.issue_correction_lines enable row level security;
create policy issue_corrections_read on public.issue_correction_lines
  for select to authenticated using (private.has_role('HR') or private.has_role('WAREHOUSE'));
revoke all on table public.issue_correction_lines from public, anon, authenticated;
grant select on public.issue_correction_lines to authenticated;

create or replace function public.create_hr_issue_correction_draft(
  p_correction_no text,
  p_original_issue_line_id uuid,
  p_issue_quantity_delta bigint,
  p_reason text,
  p_note text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.correction_notes
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  correction_row public.correction_notes;
  source_line public.hr_issue_lines;
  request_row public.hr_requests;
  item_lock_id uuid;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('HR') then
    raise exception using errcode = '42501', message = 'HR role is required';
  end if;
  if btrim(coalesce(p_correction_no, '')) = ''
     or btrim(coalesce(p_reason, '')) = ''
     or p_issue_quantity_delta = 0
     or btrim(coalesce(p_idempotency_key, '')) = ''
     or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'Correction fields are invalid';
  end if;
  insert into public.operation_commands (
    operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id
  ) values (
    'CREATE_HR_ISSUE_CORRECTION', p_idempotency_key, p_request_fingerprint, current_account
  ) on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'CREATE_HR_ISSUE_CORRECTION' and idempotency_key = p_idempotency_key
    for update;
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' then
      select * into correction_row from public.correction_notes where id = command_row.result_entity_id;
      return correction_row;
    end if;
    raise exception using errcode = '40001', message = 'HR issue correction draft is already in progress or failed';
  end if;

  select * into source_line from public.hr_issue_lines where id = p_original_issue_line_id;
  if source_line.id is null then raise exception 'Original issue line does not exist'; end if;
  select * into request_row from public.hr_requests where id = source_line.request_id;
  if request_row.id is null or request_row.status <> 'SHIPPED' then
    raise exception 'Only SHIPPED HR requests can be corrected';
  end if;
  -- Corrections and returns on different lines of the same request share one
  -- advisory fence before taking the sorted item mutex set.
  perform pg_advisory_xact_lock(hashtext(source_line.request_id::text));
  for item_lock_id in
    select distinct item_id from public.hr_issue_lines
    where request_id = source_line.request_id order by item_id
  loop
    insert into public.inventory_item_locks(item_id) values (item_lock_id)
    on conflict (item_id) do nothing;
    perform 1 from public.inventory_item_locks where item_id = item_lock_id for update;
  end loop;
  select * into request_row from public.hr_requests where id = source_line.request_id for update;
  select * into source_line from public.hr_issue_lines
  where request_id = source_line.request_id and id = p_original_issue_line_id for update;
  if request_row.status <> 'SHIPPED' or source_line.id is null then
    raise exception using errcode = '40001', message = 'Issue source changed while locking; retry';
  end if;

  insert into public.correction_notes (
    correction_no, correction_kind, status, reason, note,
    original_purchase_receipt_id, original_return_note_id, original_hr_request_id, created_by
  ) values (
    left(btrim(p_correction_no), 80), 'HR_ISSUE', 'DRAFT', left(btrim(p_reason), 500),
    nullif(left(btrim(coalesce(p_note, '')), 1000), ''), null, null,
    source_line.request_id, current_account
  ) returning * into correction_row;
  insert into public.issue_correction_lines (
    correction_note_id, original_hr_request_id, original_issue_line_id,
    employee_id, item_id, issue_quantity_delta
  ) values (
    correction_row.id, source_line.request_id, source_line.id,
    source_line.employee_id, source_line.item_id, p_issue_quantity_delta
  );
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'correction_notes',
      result_entity_id = correction_row.id, succeeded_at = now()
  where id = command_row.id;
  return correction_row;
end;
$$;

create or replace function public.post_hr_issue_correction(
  p_correction_note_id uuid,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.correction_notes
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  correction_row public.correction_notes;
  correction_line public.issue_correction_lines;
  issue_line public.hr_issue_lines;
  request_row public.hr_requests;
  item_lock_id uuid;
  hr_warehouse_id uuid;
  general_warehouse_id uuid;
  hr_balance public.inventory_balances;
  pre_issue_delta bigint;
  effective_issued bigint;
  return_total bigint;
  return_correction_total bigint;
  new_effective_issued bigint;
  combined_on_hand bigint;
  active_reserved bigint;
  posting_id uuid;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('HR') then
    raise exception using errcode = '42501', message = 'HR role is required';
  end if;
  if btrim(coalesce(p_idempotency_key, '')) = ''
     or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'idempotency_key and request_fingerprint are required';
  end if;
  insert into public.operation_commands (
    operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id
  ) values (
    'POST_HR_ISSUE_CORRECTION', p_idempotency_key, p_request_fingerprint, current_account
  ) on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'POST_HR_ISSUE_CORRECTION' and idempotency_key = p_idempotency_key
    for update;
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' then
      select * into correction_row from public.correction_notes where id = command_row.result_entity_id;
      return correction_row;
    end if;
    raise exception using errcode = '40001', message = 'HR issue correction POST is already in progress or failed';
  end if;

  select * into correction_row from public.correction_notes
  where id = p_correction_note_id and correction_kind = 'HR_ISSUE';
  select * into correction_line from public.issue_correction_lines
  where correction_note_id = p_correction_note_id order by line_no limit 1;
  if correction_row.id is null or correction_row.status <> 'DRAFT' or correction_line.id is null then
    raise exception 'Only a DRAFT HR issue correction can be posted';
  end if;

  perform pg_advisory_xact_lock(hashtext(correction_line.original_hr_request_id::text));
  for item_lock_id in
    select distinct item_id from public.hr_issue_lines
    where request_id = correction_line.original_hr_request_id order by item_id
  loop
    insert into public.inventory_item_locks(item_id) values (item_lock_id)
    on conflict (item_id) do nothing;
    perform 1 from public.inventory_item_locks where item_id = item_lock_id for update;
  end loop;
  select * into correction_row from public.correction_notes where id = p_correction_note_id for update;
  select * into correction_line from public.issue_correction_lines
  where correction_note_id = p_correction_note_id order by line_no limit 1 for update;
  select * into issue_line from public.hr_issue_lines
  where request_id = correction_line.original_hr_request_id
    and id = correction_line.original_issue_line_id for update;
  select * into request_row from public.hr_requests where id = issue_line.request_id for update;
  if correction_row.status <> 'DRAFT' or correction_row.original_hr_request_id <> request_row.id
     or request_row.status <> 'SHIPPED' or issue_line.item_id <> correction_line.item_id
     or issue_line.employee_id <> correction_line.employee_id then
    raise exception using errcode = '40001', message = 'HR issue source changed while locking; retry';
  end if;

  select coalesce(sum(issue_quantity_delta), 0) into pre_issue_delta
  from public.issue_correction_lines l
  join public.correction_notes c on c.id = l.correction_note_id
  where l.original_hr_request_id = issue_line.request_id
    and l.original_issue_line_id = issue_line.id
    and c.status = 'POSTED' and c.id <> correction_row.id;
  effective_issued := issue_line.quantity + pre_issue_delta;
  new_effective_issued := effective_issued + correction_line.issue_quantity_delta;
  if new_effective_issued < 0 then
    raise exception 'Effective issued quantity cannot be negative';
  end if;
  select coalesce(sum(rl.quantity), 0) into return_total
  from public.return_lines rl
  join public.return_notes rn on rn.id = rl.return_note_id
  where rn.status = 'POSTED' and rl.original_issue_line_id = issue_line.id;
  select coalesce(sum(rc.return_quantity_delta), 0) into return_correction_total
  from public.return_correction_lines rc
  join public.correction_notes c on c.id = rc.correction_note_id
  where c.status = 'POSTED' and rc.original_issue_line_id = issue_line.id
    and c.id <> correction_row.id;
  if return_total + return_correction_total > new_effective_issued then
    raise exception 'Effective returned quantity exceeds effective issued quantity';
  end if;

  select id into hr_warehouse_id from public.warehouses where purpose = 'HR' and is_active order by id limit 1;
  select id into general_warehouse_id from public.warehouses where purpose = 'GENERAL' and is_active order by id limit 1;
  if hr_warehouse_id is null or general_warehouse_id is null then
    raise exception 'Active HR and GENERAL warehouses are required';
  end if;
  insert into public.inventory_balances (warehouse_id, item_id)
  values (hr_warehouse_id, issue_line.item_id), (general_warehouse_id, issue_line.item_id)
  on conflict (warehouse_id, item_id) do nothing;
  perform 1 from public.inventory_balances b
  where b.item_id = issue_line.item_id and b.warehouse_id in (hr_warehouse_id, general_warehouse_id)
  order by b.warehouse_id for update;
  perform 1 from public.inventory_reservations r
  where r.item_id = issue_line.item_id and r.status = 'ACTIVE'
  order by r.source_hr_request_id, r.id for update;
  select coalesce(sum(b.on_hand_quantity), 0) into combined_on_hand
  from public.inventory_balances b
  where b.item_id = issue_line.item_id and b.warehouse_id in (hr_warehouse_id, general_warehouse_id);
  select coalesce(sum(r.quantity), 0) into active_reserved
  from public.inventory_reservations r where r.item_id = issue_line.item_id and r.status = 'ACTIVE';
  if combined_on_hand - correction_line.issue_quantity_delta < active_reserved then
    raise exception 'HR issue correction exceeds unreserved aggregate stock';
  end if;

  insert into public.inventory_postings (idempotency_key, posting_kind, source_entity_id, posted_by)
  values (p_idempotency_key, 'CORRECTION', p_correction_note_id, current_account)
  returning id into posting_id;
  insert into public.correction_posting_sources (posting_id, correction_note_id)
  values (posting_id, p_correction_note_id);
  insert into public.inventory_ledger_entries
    (posting_id, line_no, warehouse_id, item_id, movement_kind, quantity_delta, occurred_on)
  values (posting_id, 1, hr_warehouse_id, issue_line.item_id,
    'HR_ISSUE_CORRECTION', -correction_line.issue_quantity_delta, current_date);
  update public.inventory_balances
  set on_hand_quantity = on_hand_quantity - correction_line.issue_quantity_delta,
      version = version + 1, last_posting_id = posting_id, updated_at = now()
  where warehouse_id = hr_warehouse_id and item_id = issue_line.item_id;
  update public.correction_notes
  set status = 'POSTED', posted_at = now(), posted_by = current_account
  where id = p_correction_note_id returning * into correction_row;
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'correction_notes',
      result_entity_id = p_correction_note_id, succeeded_at = now()
  where id = command_row.id;
  return correction_row;
end;
$$;

create or replace function public.get_hr_issue_correction_status(
  p_correction_note_id uuid default null,
  p_create_idempotency_key text default null,
  p_post_idempotency_key text default null
)
returns public.correction_notes
language plpgsql security definer set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  correction_id uuid := p_correction_note_id;
  correction_row public.correction_notes;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('HR') then
    raise exception using errcode = '42501', message = 'HR role is required';
  end if;
  if correction_id is null and btrim(coalesce(p_create_idempotency_key, '')) <> '' then
    select result_entity_id into correction_id from public.operation_commands
    where operation_code = 'CREATE_HR_ISSUE_CORRECTION'
      and idempotency_key = p_create_idempotency_key and actor_account_id = current_account;
  end if;
  if correction_id is null and btrim(coalesce(p_post_idempotency_key, '')) <> '' then
    select result_entity_id into correction_id from public.operation_commands
    where operation_code = 'POST_HR_ISSUE_CORRECTION'
      and idempotency_key = p_post_idempotency_key and actor_account_id = current_account;
  end if;
  if correction_id is null then return null; end if;
  select * into correction_row from public.correction_notes
  where id = correction_id and created_by = current_account and correction_kind = 'HR_ISSUE';
  return correction_row;
end;
$$;

revoke all on function public.create_hr_issue_correction_draft(text, uuid, bigint, text, text, text, text) from public, anon;
revoke all on function public.post_hr_issue_correction(uuid, text, text) from public, anon;
revoke all on function public.get_hr_issue_correction_status(uuid, text, text) from public, anon;
grant execute on function public.create_hr_issue_correction_draft(text, uuid, bigint, text, text, text, text) to authenticated;
grant execute on function public.post_hr_issue_correction(uuid, text, text) to authenticated;
grant execute on function public.get_hr_issue_correction_status(uuid, text, text) to authenticated;
