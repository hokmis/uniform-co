-- Warehouse POST: total-warehouse transfer, HR warehouse issue and immutable shipment.

alter table public.hr_requests
  add column shipped_at timestamptz,
  add column shipped_by uuid references public.app_accounts(id),
  add column cancelled_at timestamptz,
  add column cancelled_by uuid references public.app_accounts(id),
  add column cancellation_reason text;

create table public.transfer_short_ship_reasons (
  code text primary key check (btrim(code) <> ''),
  label text not null check (btrim(label) <> ''),
  is_active boolean not null default true,
  sort_order integer not null default 0
);

create table public.warehouse_shipments (
  id uuid primary key default gen_random_uuid(),
  shipment_no text not null unique check (btrim(shipment_no) <> ''),
  hr_request_id uuid not null references public.hr_requests(id),
  status text not null default 'DRAFT' check (status in ('DRAFT', 'POSTED')),
  created_by uuid not null references public.app_accounts(id),
  source_request_row_version bigint,
  posted_at timestamptz,
  posted_by uuid references public.app_accounts(id),
  note text,
  unique (hr_request_id),
  unique (id, hr_request_id)
);

create table public.warehouse_shipment_lines (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null,
  hr_request_id uuid not null,
  hr_request_item_id uuid not null,
  item_id uuid not null,
  requested_transfer_quantity_snapshot bigint,
  general_on_hand_snapshot bigint,
  maximum_transfer_quantity_snapshot bigint,
  actual_transfer_quantity bigint,
  transfer_difference_quantity bigint generated always as (
    requested_transfer_quantity_snapshot - actual_transfer_quantity
  ) stored,
  short_ship_reason_code text references public.transfer_short_ship_reasons(code),
  unique (shipment_id, hr_request_item_id),
  unique (shipment_id, id),
  foreign key (shipment_id, hr_request_id)
    references public.warehouse_shipments(id, hr_request_id),
  foreign key (hr_request_id, hr_request_item_id, item_id)
    references public.hr_request_items(request_id, id, item_id),
  check (requested_transfer_quantity_snapshot is null or requested_transfer_quantity_snapshot > 0),
  check (general_on_hand_snapshot is null or general_on_hand_snapshot >= 0),
  check (maximum_transfer_quantity_snapshot is null or maximum_transfer_quantity_snapshot >= 0),
  check (actual_transfer_quantity is null or actual_transfer_quantity >= 0),
  check (
    maximum_transfer_quantity_snapshot is null
    or actual_transfer_quantity is null
    or actual_transfer_quantity <= maximum_transfer_quantity_snapshot
  )
);

create or replace function private.prevent_posted_shipment_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  if tg_table_name = 'warehouse_shipments' then
    if old.status = 'POSTED' then
      raise exception 'Posted warehouse shipments are immutable';
    end if;
    if old.hr_request_id <> new.hr_request_id then
      raise exception 'A shipment cannot be moved to another HR request';
    end if;
  elsif exists (
    select 1
    from public.warehouse_shipments s
    where s.id = old.shipment_id and s.status = 'POSTED'
  ) then
    raise exception 'Posted warehouse shipment lines are immutable';
  end if;
  return new;
end;
$$;

create trigger warehouse_shipments_immutable_guard
before update or delete on public.warehouse_shipments
for each row execute function private.prevent_posted_shipment_mutation();

create trigger warehouse_shipment_lines_immutable_guard
before update or delete on public.warehouse_shipment_lines
for each row execute function private.prevent_posted_shipment_mutation();

create or replace function public.post_warehouse_shipment(
  p_shipment_id uuid,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.warehouse_shipments
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  shipment_row public.warehouse_shipments;
  request_row public.hr_requests;
  item_row record;
  line_row record;
  item_id_row record;
  item_ids uuid[];
  current_item_ids uuid[];
  initial_request_id uuid;
  hr_warehouse_id uuid;
  general_warehouse_id uuid;
  hr_on_hand bigint;
  general_on_hand bigint;
  other_reserved bigint;
  issue_sum bigint;
  maximum_transfer bigint;
  actual_transfer bigint;
  line_no integer := 0;
  posted_row public.warehouse_shipments;
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
    'POST_WAREHOUSE_SHIPMENT', p_idempotency_key, p_request_fingerprint, current_account
  ) on conflict (operation_code, idempotency_key) do nothing
  returning * into command_row;

  if command_row.id is null then
    select * into command_row
    from public.operation_commands
    where operation_code = 'POST_WAREHOUSE_SHIPMENT'
      and idempotency_key = p_idempotency_key
    for update;
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' and command_row.result_entity_id = p_shipment_id then
      select * into posted_row from public.warehouse_shipments where id = p_shipment_id;
      return posted_row;
    end if;
    raise exception using errcode = '40001', message = 'shipment is already in progress or failed';
  end if;

  select hr_request_id into initial_request_id
  from public.warehouse_shipments
  where id = p_shipment_id;
  if initial_request_id is null then
    raise exception 'Warehouse shipment does not exist';
  end if;

  select coalesce(array_agg(item_id order by item_id), '{}'::uuid[])
    into item_ids
  from (
    select distinct item_id
    from public.warehouse_shipment_lines
    where shipment_id = p_shipment_id
  ) source_items;
  if cardinality(item_ids) = 0 then
    raise exception 'Shipment must contain at least one item';
  end if;

  -- Global order: operation command -> item mutexes -> request -> shipment -> request items -> balances -> reservations.
  insert into public.inventory_item_locks (item_id)
  select item_id
  from unnest(item_ids) as requested(item_id)
  order by item_id
  on conflict (item_id) do nothing;

  for item_id_row in
    select item_id from unnest(item_ids) as requested(item_id) order by item_id
  loop
    perform 1 from public.inventory_item_locks
    where item_id = item_id_row.item_id
    for update;
  end loop;

  select * into request_row
  from public.hr_requests
  where id = initial_request_id
  for update;
  if request_row.id is null then
    raise exception 'HR request does not exist';
  end if;

  select * into shipment_row
  from public.warehouse_shipments
  where id = p_shipment_id
  for update;
  if shipment_row.id is null or shipment_row.hr_request_id <> request_row.id then
    raise exception 'Shipment source request changed; retry';
  end if;
  if shipment_row.status <> 'DRAFT' then
    raise exception 'Only DRAFT shipments can be posted';
  end if;
  if request_row.status <> 'SUBMITTED' then
    raise exception 'Only SUBMITTED HR requests can be shipped';
  end if;
  if shipment_row.source_request_row_version is not null
     and shipment_row.source_request_row_version <> request_row.row_version then
    raise exception using errcode = '40001', message = 'Shipment source request version is stale';
  end if;

  select coalesce(array_agg(item_id order by item_id), '{}'::uuid[])
    into current_item_ids
  from (
    select distinct item_id
    from public.warehouse_shipment_lines
    where shipment_id = p_shipment_id
  ) current_items;
  if current_item_ids is distinct from item_ids then
    raise exception using errcode = '40001', message = 'Shipment item set changed while locking; retry';
  end if;
  if exists (
    select 1
    from public.hr_request_items ri
    where ri.request_id = request_row.id
      and not exists (
        select 1 from public.warehouse_shipment_lines sl
        where sl.shipment_id = p_shipment_id and sl.hr_request_item_id = ri.id
      )
  ) or exists (
    select 1
    from public.warehouse_shipment_lines sl
    where sl.shipment_id = p_shipment_id
      and not exists (
        select 1 from public.hr_request_items ri
        where ri.request_id = request_row.id and ri.id = sl.hr_request_item_id
      )
  ) then
    raise exception 'Shipment lines must exactly match the HR request item set';
  end if;

  for item_id_row in
    select item_id from unnest(item_ids) as requested(item_id) order by item_id
  loop
    perform 1 from public.hr_request_items
    where request_id = request_row.id and item_id = item_id_row.item_id
    for update;
  end loop;

  select id into hr_warehouse_id
  from public.warehouses where purpose = 'HR' and is_active;
  select id into general_warehouse_id
  from public.warehouses where purpose = 'GENERAL' and is_active;
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
    order by b.item_id, b.warehouse_id
    for update;
  end loop;

  for item_id_row in
    select item_id from unnest(item_ids) as requested(item_id) order by item_id
  loop
    perform 1 from public.inventory_reservations r
    where r.item_id = item_id_row.item_id and r.status = 'ACTIVE'
    order by r.item_id, r.source_hr_request_id, r.id
    for update;
  end loop;

  for item_row in
    select ri.*
    from public.hr_request_items ri
    where ri.request_id = request_row.id
    order by ri.item_id
  loop
    select b.on_hand_quantity into hr_on_hand
    from public.inventory_balances b where b.warehouse_id = hr_warehouse_id and b.item_id = item_row.item_id;
    select b.on_hand_quantity into general_on_hand
    from public.inventory_balances b where b.warehouse_id = general_warehouse_id and b.item_id = item_row.item_id;
    select coalesce(sum(r.quantity), 0) into other_reserved
    from public.inventory_reservations r
    where r.item_id = item_row.item_id
      and r.status = 'ACTIVE'
      and r.source_hr_request_id <> request_row.id;
    if not exists (
      select 1
      from public.inventory_reservations r
      where r.item_id = item_row.item_id
        and r.source_hr_request_id = request_row.id
        and r.status = 'ACTIVE'
        and r.quantity = item_row.requested_transfer_quantity
    ) then
      raise exception 'Active reservation is missing or stale for item %', item_row.item_id;
    end if;

    select sl.* into line_row
    from public.warehouse_shipment_lines sl
    where sl.shipment_id = p_shipment_id and sl.hr_request_item_id = item_row.id
    for update;
    if line_row.id is null or line_row.actual_transfer_quantity is null then
      raise exception 'Every shipment line needs an actual transfer quantity';
    end if;

    maximum_transfer := least(item_row.requested_transfer_quantity, general_on_hand);
    actual_transfer := line_row.actual_transfer_quantity;
    if actual_transfer < 0 then
      raise exception 'Actual transfer cannot be negative for item %', item_row.item_id;
    end if;
    if actual_transfer > maximum_transfer then
      raise exception 'Actual transfer exceeds the locked GENERAL warehouse maximum for item %', item_row.item_id;
    end if;
    if actual_transfer < maximum_transfer and not exists (
      select 1 from public.transfer_short_ship_reasons r
      where r.code = line_row.short_ship_reason_code and r.is_active
    ) then
      raise exception 'A short-ship reason is required for item %', item_row.item_id;
    end if;
    if hr_on_hand + actual_transfer - item_row.issue_quantity < 0 then
      raise exception 'HR warehouse would become negative for item %', item_row.item_id;
    end if;
    if hr_on_hand + general_on_hand - item_row.issue_quantity < other_reserved then
      raise exception 'Posting would leave other active reservations uncovered for item %', item_row.item_id;
    end if;

    update public.warehouse_shipment_lines
    set hr_request_id = request_row.id,
        item_id = item_row.item_id,
        requested_transfer_quantity_snapshot = item_row.requested_transfer_quantity,
        general_on_hand_snapshot = general_on_hand,
        maximum_transfer_quantity_snapshot = maximum_transfer,
        actual_transfer_quantity = actual_transfer
    where id = line_row.id;
  end loop;

  insert into public.inventory_postings (
    idempotency_key, posting_kind, source_entity_id, posted_by
  ) values (
    p_idempotency_key, 'WAREHOUSE_SHIPMENT', p_shipment_id, current_account
  );

  for item_row in
    select ri.*
    from public.hr_request_items ri
    where ri.request_id = request_row.id
    order by ri.item_id
  loop
    select sl.actual_transfer_quantity into actual_transfer
    from public.warehouse_shipment_lines sl
    where sl.shipment_id = p_shipment_id and sl.hr_request_item_id = item_row.id;
    line_no := line_no + 1;
    insert into public.inventory_ledger_entries (
      posting_id, line_no, warehouse_id, item_id, movement_kind, quantity_delta, occurred_on
    )
    select p.id, line_no, general_warehouse_id, item_row.item_id, 'WAREHOUSE_SHIPMENT_OUT', -actual_transfer, request_row.distribution_date
    from public.inventory_postings p where p.idempotency_key = p_idempotency_key;
    line_no := line_no + 1;
    insert into public.inventory_ledger_entries (
      posting_id, line_no, warehouse_id, item_id, movement_kind, quantity_delta, occurred_on
    )
    select p.id, line_no, hr_warehouse_id, item_row.item_id, 'HR_ISSUE_AND_REPLENISH', actual_transfer - item_row.issue_quantity, request_row.distribution_date
    from public.inventory_postings p where p.idempotency_key = p_idempotency_key;
  end loop;

  for item_row in
    select ri.*
    from public.hr_request_items ri
    where ri.request_id = request_row.id
    order by ri.item_id
  loop
    select sl.actual_transfer_quantity into actual_transfer
    from public.warehouse_shipment_lines sl
    where sl.shipment_id = p_shipment_id and sl.hr_request_item_id = item_row.id;
    update public.inventory_balances
    set on_hand_quantity = on_hand_quantity - actual_transfer,
        version = version + 1,
        last_posting_id = (select id from public.inventory_postings where idempotency_key = p_idempotency_key),
        updated_at = now()
    where warehouse_id = general_warehouse_id and item_id = item_row.item_id;
    update public.inventory_balances
    set on_hand_quantity = on_hand_quantity + actual_transfer - item_row.issue_quantity,
        version = version + 1,
        last_posting_id = (select id from public.inventory_postings where idempotency_key = p_idempotency_key),
        updated_at = now()
    where warehouse_id = hr_warehouse_id and item_id = item_row.item_id;
    update public.inventory_reservations
    set status = 'CLOSED', closed_at = now()
    where source_hr_request_id = request_row.id and item_id = item_row.item_id and status = 'ACTIVE';
  end loop;

  update public.hr_requests
  set status = 'SHIPPED',
      shipped_at = now(),
      shipped_by = current_account,
      row_version = row_version + 1
  where id = request_row.id;

  update public.warehouse_shipments
  set status = 'POSTED',
      source_request_row_version = request_row.row_version + 1,
      posted_at = now(),
      posted_by = current_account
  where id = p_shipment_id;

  update public.operation_commands
  set status = 'SUCCEEDED',
      result_entity_type = 'warehouse_shipments',
      result_entity_id = p_shipment_id,
      succeeded_at = now()
  where id = command_row.id;

  select * into posted_row from public.warehouse_shipments where id = p_shipment_id;
  return posted_row;
end;
$$;

revoke all on function public.post_warehouse_shipment(uuid, text, text) from public, anon;
grant execute on function public.post_warehouse_shipment(uuid, text, text) to authenticated;

alter table public.transfer_short_ship_reasons enable row level security;
alter table public.warehouse_shipments enable row level security;
alter table public.warehouse_shipment_lines enable row level security;

create policy transfer_short_ship_reasons_read on public.transfer_short_ship_reasons
  for select to authenticated using (is_active or private.has_role('HR') or private.has_role('WAREHOUSE'));
create policy warehouse_shipments_read on public.warehouse_shipments
  for select to authenticated using (private.has_role('HR') or private.has_role('WAREHOUSE'));
create policy warehouse_shipment_lines_read on public.warehouse_shipment_lines
  for select to authenticated using (private.has_role('HR') or private.has_role('WAREHOUSE'));
create policy warehouse_shipments_draft_insert on public.warehouse_shipments
  for insert to authenticated with check (
    private.has_role('WAREHOUSE') and created_by = private.current_account_id() and status = 'DRAFT'
  );
create policy warehouse_shipments_draft_update on public.warehouse_shipments
  for update to authenticated using (
    private.has_role('WAREHOUSE') and created_by = private.current_account_id() and status = 'DRAFT'
  ) with check (
    private.has_role('WAREHOUSE') and created_by = private.current_account_id() and status = 'DRAFT'
  );
create policy warehouse_shipment_lines_draft_insert on public.warehouse_shipment_lines
  for insert to authenticated with check (exists (
    select 1 from public.warehouse_shipments s
    where s.id = shipment_id and s.created_by = private.current_account_id()
      and s.status = 'DRAFT' and private.has_role('WAREHOUSE')
  ));
create policy warehouse_shipment_lines_draft_update on public.warehouse_shipment_lines
  for update to authenticated using (exists (
    select 1 from public.warehouse_shipments s
    where s.id = shipment_id and s.created_by = private.current_account_id()
      and s.status = 'DRAFT' and private.has_role('WAREHOUSE')
  )) with check (exists (
    select 1 from public.warehouse_shipments s
    where s.id = shipment_id and s.created_by = private.current_account_id()
      and s.status = 'DRAFT' and private.has_role('WAREHOUSE')
  ));

revoke all on table public.transfer_short_ship_reasons,
  public.warehouse_shipments, public.warehouse_shipment_lines from public, anon, authenticated;
grant select on public.transfer_short_ship_reasons,
  public.warehouse_shipments, public.warehouse_shipment_lines to authenticated;
grant insert, update on public.warehouse_shipments, public.warehouse_shipment_lines to authenticated;

insert into public.transfer_short_ship_reasons (code, label, sort_order)
values
  ('GENERAL_STOCK_SHORT', '總倉現貨不足', 10),
  ('COUNT_DIFFERENCE', '盤點差異待查', 20),
  ('OTHER', '其他（需備註）', 90)
on conflict (code) do nothing;
