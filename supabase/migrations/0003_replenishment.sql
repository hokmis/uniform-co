-- Replenishment requests never reserve stock; only POST consumes GENERAL stock.

create table public.replenishment_requests (
  id uuid primary key default gen_random_uuid(),
  request_no text not null unique check (btrim(request_no) <> ''),
  status text not null default 'DRAFT' check (status in ('DRAFT', 'SUBMITTED', 'SHIPPED', 'CANCELLED')),
  note text,
  created_by uuid not null references public.app_accounts(id),
  submitted_at timestamptz,
  submitted_by uuid references public.app_accounts(id),
  shipped_at timestamptz,
  shipped_by uuid references public.app_accounts(id),
  cancelled_at timestamptz,
  cancelled_by uuid references public.app_accounts(id),
  cancellation_reason text,
  row_version bigint not null default 0 check (row_version >= 0),
  created_at timestamptz not null default now()
);

create table public.replenishment_request_lines (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.replenishment_requests(id),
  item_id uuid not null references public.uniform_items(id),
  requested_quantity bigint not null check (requested_quantity > 0),
  item_code_snapshot text,
  item_name_snapshot text,
  unit_snapshot text,
  request_row_version_snapshot bigint,
  general_on_hand_snapshot bigint,
  maximum_transfer_quantity_snapshot bigint,
  actual_transfer_quantity bigint,
  difference_quantity bigint generated always as (
    requested_quantity - actual_transfer_quantity
  ) stored,
  short_ship_reason_code text references public.transfer_short_ship_reasons(code),
  unique (request_id, item_id),
  unique (request_id, id, item_id),
  check (general_on_hand_snapshot is null or general_on_hand_snapshot >= 0),
  check (maximum_transfer_quantity_snapshot is null or maximum_transfer_quantity_snapshot >= 0),
  check (actual_transfer_quantity is null or actual_transfer_quantity >= 0),
  check (
    maximum_transfer_quantity_snapshot is null
    or actual_transfer_quantity is null
    or actual_transfer_quantity <= maximum_transfer_quantity_snapshot
  )
);

create or replace function private.prevent_posted_replenishment_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  if old.status in ('SUBMITTED', 'SHIPPED', 'CANCELLED') then
    raise exception 'Submitted or posted replenishment requests are immutable';
  end if;
  return new;
end;
$$;

create trigger replenishment_requests_immutable_guard
before update or delete on public.replenishment_requests
for each row execute function private.prevent_posted_replenishment_mutation();

create or replace function private.prevent_posted_replenishment_line_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  if exists (
    select 1 from public.replenishment_requests r
    where r.id = old.request_id and r.status in ('SUBMITTED', 'SHIPPED', 'CANCELLED')
  ) then
    raise exception 'Submitted or posted replenishment lines are immutable';
  end if;
  if tg_op = 'UPDATE' and old.request_id <> new.request_id then
    raise exception 'A replenishment line cannot be moved to another request';
  end if;
  return new;
end;
$$;

create trigger replenishment_lines_immutable_guard
before update or delete on public.replenishment_request_lines
for each row execute function private.prevent_posted_replenishment_line_mutation();

create or replace function public.submit_replenishment_request(
  p_request_id uuid,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.replenishment_requests
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  request_row public.replenishment_requests;
  item_id_row record;
  item_ids uuid[];
  current_item_ids uuid[];
  line_count integer;
  result_row public.replenishment_requests;
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
    'SUBMIT_REPLENISHMENT_REQUEST', p_idempotency_key, p_request_fingerprint, current_account
  ) on conflict (operation_code, idempotency_key) do nothing
  returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'SUBMIT_REPLENISHMENT_REQUEST'
      and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' and command_row.result_entity_id = p_request_id then
      select * into result_row from public.replenishment_requests where id = p_request_id;
      return result_row;
    end if;
    raise exception using errcode = '40001', message = 'replenishment request is already in progress or failed';
  end if;

  select coalesce(array_agg(item_id order by item_id), '{}'::uuid[])
    into item_ids
  from (
    select distinct item_id from public.replenishment_request_lines where request_id = p_request_id
  ) requested_items;
  if cardinality(item_ids) = 0 then
    raise exception 'Replenishment request needs at least one item';
  end if;

  insert into public.inventory_item_locks (item_id)
  select item_id from unnest(item_ids) as requested(item_id) order by item_id
  on conflict (item_id) do nothing;
  for item_id_row in
    select item_id from unnest(item_ids) as requested(item_id) order by item_id
  loop
    perform 1 from public.inventory_item_locks where item_id = item_id_row.item_id for update;
  end loop;

  select * into request_row
  from public.replenishment_requests where id = p_request_id for update;
  if request_row.id is null then
    raise exception 'Replenishment request does not exist';
  end if;
  if request_row.created_by <> current_account then
    raise exception using errcode = '42501', message = 'Only the request owner can submit this draft';
  end if;
  if request_row.status <> 'DRAFT' then
    raise exception 'Only DRAFT replenishment requests can be submitted';
  end if;

  select coalesce(array_agg(item_id order by item_id), '{}'::uuid[])
    into current_item_ids
  from (
    select distinct item_id from public.replenishment_request_lines where request_id = p_request_id
  ) current_items;
  if current_item_ids is distinct from item_ids then
    raise exception using errcode = '40001', message = 'Replenishment item set changed while locking; retry';
  end if;

  select count(*) into line_count
  from public.replenishment_request_lines where request_id = p_request_id;
  if line_count <> cardinality(item_ids) then
    raise exception 'Replenishment request cannot contain duplicate item lines';
  end if;

  update public.replenishment_request_lines l
  set item_code_snapshot = ui.item_code,
      item_name_snapshot = ui.item_name,
      unit_snapshot = ui.unit,
      request_row_version_snapshot = request_row.row_version
  from public.uniform_items ui
  where l.request_id = p_request_id and l.item_id = ui.id and ui.is_active;
  if exists (
    select 1 from public.replenishment_request_lines l
    join public.uniform_items ui on ui.id = l.item_id
    where l.request_id = p_request_id and not ui.is_active
  ) then
    raise exception 'Inactive uniform items cannot be submitted';
  end if;

  update public.replenishment_requests
  set status = 'SUBMITTED', submitted_at = now(), submitted_by = current_account,
      row_version = row_version + 1
  where id = p_request_id
  returning * into result_row;
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'replenishment_requests',
      result_entity_id = p_request_id, succeeded_at = now()
  where id = command_row.id;
  return result_row;
end;
$$;

create or replace function public.post_replenishment_request(
  p_request_id uuid,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.replenishment_requests
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  request_row public.replenishment_requests;
  item_row record;
  line_row record;
  item_id_row record;
  item_ids uuid[];
  current_item_ids uuid[];
  hr_warehouse_id uuid;
  general_warehouse_id uuid;
  general_on_hand bigint;
  maximum_transfer bigint;
  actual_transfer bigint;
  line_no integer := 0;
  result_row public.replenishment_requests;
  posting_id uuid;
begin
  current_account := private.current_account_id();
  if auth.uid() is null
     or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null
     or not private.has_role('WAREHOUSE') then
    raise exception using errcode = '42501', message = 'WAREHOUSE role is required';
  end if;
  if btrim(coalesce(p_idempotency_key, '')) = ''
     or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'idempotency_key and request_fingerprint are required';
  end if;
  insert into public.operation_commands (
    operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id
  ) values (
    'POST_REPLENISHMENT_REQUEST', p_idempotency_key, p_request_fingerprint, current_account
  ) on conflict (operation_code, idempotency_key) do nothing
  returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'POST_REPLENISHMENT_REQUEST'
      and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' and command_row.result_entity_id = p_request_id then
      select * into result_row from public.replenishment_requests where id = p_request_id;
      return result_row;
    end if;
    raise exception using errcode = '40001', message = 'replenishment POST is already in progress or failed';
  end if;

  select coalesce(array_agg(item_id order by item_id), '{}'::uuid[])
    into item_ids
  from (
    select distinct item_id from public.replenishment_request_lines where request_id = p_request_id
  ) requested_items;
  if cardinality(item_ids) = 0 then
    raise exception 'Replenishment request needs at least one item';
  end if;
  insert into public.inventory_item_locks (item_id)
  select item_id from unnest(item_ids) as requested(item_id) order by item_id
  on conflict (item_id) do nothing;
  for item_id_row in
    select item_id from unnest(item_ids) as requested(item_id) order by item_id
  loop
    perform 1 from public.inventory_item_locks where item_id = item_id_row.item_id for update;
  end loop;

  select * into request_row from public.replenishment_requests
  where id = p_request_id for update;
  if request_row.id is null or request_row.status <> 'SUBMITTED' then
    raise exception 'Only SUBMITTED replenishment requests can be posted';
  end if;
  select coalesce(array_agg(item_id order by item_id), '{}'::uuid[])
    into current_item_ids
  from (
    select distinct item_id from public.replenishment_request_lines where request_id = p_request_id
  ) current_items;
  if current_item_ids is distinct from item_ids then
    raise exception using errcode = '40001', message = 'Replenishment item set changed while locking; retry';
  end if;

  for item_id_row in
    select item_id from unnest(item_ids) as requested(item_id) order by item_id
  loop
    perform 1 from public.replenishment_request_lines
    where request_id = p_request_id and item_id = item_id_row.item_id for update;
  end loop;
  select id into hr_warehouse_id from public.warehouses where purpose = 'HR' and is_active;
  select id into general_warehouse_id from public.warehouses where purpose = 'GENERAL' and is_active;
  if hr_warehouse_id is null or general_warehouse_id is null then
    raise exception 'Both active HR and GENERAL warehouses are required';
  end if;
  insert into public.inventory_balances (warehouse_id, item_id)
  select w.id, item_id_row.item_id
  from (values (hr_warehouse_id), (general_warehouse_id)) as w(id),
       unnest(item_ids) as item_id_row(item_id)
  on conflict (warehouse_id, item_id) do nothing;
  for item_id_row in
    select item_id from unnest(item_ids) as requested(item_id) order by item_id
  loop
    perform 1 from public.inventory_balances b
    where b.item_id = item_id_row.item_id
      and b.warehouse_id in (hr_warehouse_id, general_warehouse_id)
    order by b.item_id, b.warehouse_id for update;
  end loop;

  for item_row in
    select l.* from public.replenishment_request_lines l
    where l.request_id = p_request_id order by l.item_id
  loop
    select b.on_hand_quantity into general_on_hand from public.inventory_balances b
    where b.warehouse_id = general_warehouse_id and b.item_id = item_row.item_id;
    maximum_transfer := least(item_row.requested_quantity, general_on_hand);
    actual_transfer := item_row.actual_transfer_quantity;
    if actual_transfer is null then
      raise exception 'Every replenishment line needs an actual transfer quantity';
    end if;
    if actual_transfer < 0 then
      raise exception 'Actual replenishment transfer cannot be negative';
    end if;
    if actual_transfer > maximum_transfer then
      raise exception 'Actual replenishment transfer exceeds GENERAL stock for item %', item_row.item_id;
    end if;
    if actual_transfer < maximum_transfer and not exists (
      select 1 from public.transfer_short_ship_reasons r
      where r.code = item_row.short_ship_reason_code and r.is_active
    ) then
      raise exception 'A short-ship reason is required for item %', item_row.item_id;
    end if;
    update public.replenishment_request_lines
    set request_row_version_snapshot = request_row.row_version,
        general_on_hand_snapshot = general_on_hand,
        maximum_transfer_quantity_snapshot = maximum_transfer,
        actual_transfer_quantity = actual_transfer
    where id = item_row.id;
  end loop;

  insert into public.inventory_postings (
    idempotency_key, posting_kind, source_entity_id, posted_by
  ) values (p_idempotency_key, 'REPLENISHMENT', p_request_id, current_account)
  returning id into posting_id;
  for item_row in
    select l.* from public.replenishment_request_lines l
    where l.request_id = p_request_id order by l.item_id
  loop
    line_no := line_no + 1;
    insert into public.inventory_ledger_entries
      (posting_id, line_no, warehouse_id, item_id, movement_kind, quantity_delta, occurred_on)
    values (posting_id, line_no, general_warehouse_id, item_row.item_id,
      'REPLENISHMENT_OUT', -item_row.actual_transfer_quantity, current_date);
    update public.inventory_balances
    set on_hand_quantity = on_hand_quantity - item_row.actual_transfer_quantity,
        version = version + 1, last_posting_id = posting_id, updated_at = now()
    where warehouse_id = general_warehouse_id and item_id = item_row.item_id;
    line_no := line_no + 1;
    insert into public.inventory_ledger_entries
      (posting_id, line_no, warehouse_id, item_id, movement_kind, quantity_delta, occurred_on)
    values (posting_id, line_no, hr_warehouse_id, item_row.item_id,
      'REPLENISHMENT_IN', item_row.actual_transfer_quantity, current_date);
    update public.inventory_balances
    set on_hand_quantity = on_hand_quantity + item_row.actual_transfer_quantity,
        version = version + 1, last_posting_id = posting_id, updated_at = now()
    where warehouse_id = hr_warehouse_id and item_id = item_row.item_id;
  end loop;

  update public.replenishment_requests
  set status = 'SHIPPED', shipped_at = now(), shipped_by = current_account,
      row_version = row_version + 1
  where id = p_request_id
  returning * into result_row;
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'replenishment_requests',
      result_entity_id = p_request_id, succeeded_at = now()
  where id = command_row.id;
  return result_row;
end;
$$;

revoke all on function public.submit_replenishment_request(uuid, text, text) from public, anon;
revoke all on function public.post_replenishment_request(uuid, text, text) from public, anon;
grant execute on function public.submit_replenishment_request(uuid, text, text) to authenticated;
grant execute on function public.post_replenishment_request(uuid, text, text) to authenticated;

alter table public.replenishment_requests enable row level security;
alter table public.replenishment_request_lines enable row level security;

create policy replenishment_requests_read on public.replenishment_requests
  for select to authenticated using (private.has_role('HR') or private.has_role('WAREHOUSE'));
create policy replenishment_request_lines_read on public.replenishment_request_lines
  for select to authenticated using (private.has_role('HR') or private.has_role('WAREHOUSE'));
create policy replenishment_requests_draft_insert on public.replenishment_requests
  for insert to authenticated with check (
    private.has_role('HR') and created_by = private.current_account_id() and status = 'DRAFT'
  );
create policy replenishment_requests_draft_update on public.replenishment_requests
  for update to authenticated using (
    private.has_role('HR') and created_by = private.current_account_id() and status = 'DRAFT'
  ) with check (
    private.has_role('HR') and created_by = private.current_account_id() and status = 'DRAFT'
  );
create policy replenishment_lines_draft_insert on public.replenishment_request_lines
  for insert to authenticated with check (exists (
    select 1 from public.replenishment_requests r
    where r.id = request_id and r.created_by = private.current_account_id()
      and r.status = 'DRAFT' and private.has_role('HR')
  ));
create policy replenishment_lines_draft_update on public.replenishment_request_lines
  for update to authenticated using (exists (
    select 1 from public.replenishment_requests r
    where r.id = request_id and r.created_by = private.current_account_id()
      and r.status = 'DRAFT' and private.has_role('HR')
  )) with check (exists (
    select 1 from public.replenishment_requests r
    where r.id = request_id and r.created_by = private.current_account_id()
      and r.status = 'DRAFT' and private.has_role('HR')
  ));

revoke all on table public.replenishment_requests, public.replenishment_request_lines
  from public, anon, authenticated;
grant select on public.replenishment_requests, public.replenishment_request_lines to authenticated;
grant insert, update on public.replenishment_requests, public.replenishment_request_lines to authenticated;
