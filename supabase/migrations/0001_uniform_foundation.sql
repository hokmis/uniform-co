-- uniform-co foundation: master data, two-warehouse balances and HR request reservations
create extension if not exists pgcrypto;

create schema if not exists private;

create type public.app_role as enum (
  'SYSTEM_ADMIN', 'HR', 'WAREHOUSE', 'PROCUREMENT', 'CEO', 'DEMAND_COORDINATOR'
);

create type public.hr_request_status as enum (
  'DRAFT', 'SUBMITTED', 'INVENTORY_REVIEW_REQUIRED', 'SHIPPED', 'CANCELLED'
);

create table public.app_accounts (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique,
  display_name text not null,
  email_snapshot text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.user_roles (
  account_id uuid not null references public.app_accounts(id),
  role_code public.app_role not null,
  primary key (account_id, role_code)
);

create table public.operation_commands (
  id uuid primary key default gen_random_uuid(),
  operation_code text not null,
  idempotency_key text not null,
  canonical_request_fingerprint text not null,
  actor_account_id uuid not null references public.app_accounts(id),
  status text not null default 'IN_PROGRESS' check (status in ('IN_PROGRESS', 'SUCCEEDED', 'RETRYABLE_FAILED', 'TERMINAL_FAILED')),
  result_entity_type text,
  result_entity_id uuid,
  started_at timestamptz not null default now(),
  succeeded_at timestamptz,
  last_error_code text,
  unique (operation_code, idempotency_key)
);

create table public.institutions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (btrim(code) <> ''),
  name text not null check (btrim(name) <> ''),
  is_active boolean not null default true
);

create table public.departments (
  id uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institutions(id),
  code text not null check (btrim(code) <> ''),
  name text not null check (btrim(name) <> ''),
  is_active boolean not null default true,
  unique (institution_id, code),
  unique (id, institution_id)
);

create table public.coordinator_scopes (
  account_id uuid not null references public.app_accounts(id),
  institution_id uuid not null references public.institutions(id),
  department_id uuid not null,
  primary key (account_id, institution_id, department_id),
  foreign key (department_id, institution_id)
    references public.departments(id, institution_id)
);

create table public.employees (
  id uuid primary key default gen_random_uuid(),
  employee_no text not null unique check (btrim(employee_no) <> ''),
  name text not null check (btrim(name) <> ''),
  institution_id uuid not null references public.institutions(id),
  department_id uuid not null,
  employment_status text not null default 'ACTIVE' check (employment_status in ('ACTIVE', 'INACTIVE')),
  job_title text,
  hire_date date,
  termination_date date,
  note text,
  foreign key (department_id, institution_id)
    references public.departments(id, institution_id)
);

create table public.uniform_items (
  id uuid primary key default gen_random_uuid(),
  item_code text not null unique check (btrim(item_code) <> ''),
  item_name text not null check (btrim(item_name) <> ''),
  unit text not null default '件' check (btrim(unit) <> ''),
  size text,
  category text,
  season text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  supplier_code text not null unique check (btrim(supplier_code) <> ''),
  name text not null check (btrim(name) <> ''),
  default_currency char(3),
  is_active boolean not null default true,
  check (default_currency is null or default_currency = upper(btrim(default_currency)))
);

create table public.supplier_uniform_items (
  supplier_id uuid not null references public.suppliers(id),
  item_id uuid not null references public.uniform_items(id),
  minimum_order_quantity bigint check (minimum_order_quantity is null or minimum_order_quantity > 0),
  supplier_item_code text,
  is_active boolean not null default true,
  primary key (supplier_id, item_id)
);

create table public.warehouses (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (btrim(code) <> ''),
  name text not null check (btrim(name) <> ''),
  purpose text not null check (purpose in ('HR', 'GENERAL')),
  is_active boolean not null default true
);

create unique index warehouses_one_active_per_purpose
  on public.warehouses (purpose) where is_active;

create table public.inventory_balances (
  warehouse_id uuid not null references public.warehouses(id),
  item_id uuid not null references public.uniform_items(id),
  on_hand_quantity bigint not null default 0 check (on_hand_quantity >= 0),
  version bigint not null default 0 check (version >= 0),
  last_posting_id uuid,
  updated_at timestamptz not null default now(),
  primary key (warehouse_id, item_id)
);

create table public.inventory_item_locks (
  item_id uuid primary key references public.uniform_items(id)
);

create table public.hr_requests (
  id uuid primary key default gen_random_uuid(),
  request_no text not null unique,
  status public.hr_request_status not null default 'DRAFT',
  distribution_date date not null,
  note text,
  created_by uuid not null references public.app_accounts(id),
  submitted_at timestamptz,
  submitted_by uuid references public.app_accounts(id),
  row_version bigint not null default 0 check (row_version >= 0),
  created_at timestamptz not null default now()
);

create table public.hr_issue_lines (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.hr_requests(id),
  employee_id uuid not null references public.employees(id),
  item_id uuid not null references public.uniform_items(id),
  line_no integer not null check (line_no > 0),
  quantity bigint not null check (quantity > 0),
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
  unique (request_id, id),
  unique (request_id, line_no),
  unique (request_id, employee_id, item_id)
);

create table public.hr_request_items (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.hr_requests(id),
  item_id uuid not null references public.uniform_items(id),
  issue_quantity bigint not null default 0 check (issue_quantity >= 0),
  increase_quantity bigint not null default 0 check (increase_quantity >= 0),
  requested_transfer_quantity bigint generated always as (issue_quantity + increase_quantity) stored,
  item_code_snapshot text,
  item_name_snapshot text,
  unit_snapshot text,
  unique (request_id, item_id),
  unique (request_id, id, item_id),
  check (issue_quantity + increase_quantity > 0)
);

create table public.inventory_reservations (
  id uuid primary key default gen_random_uuid(),
  source_hr_request_id uuid not null references public.hr_requests(id),
  item_id uuid not null references public.uniform_items(id),
  quantity bigint not null check (quantity > 0),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'CLOSED', 'RELEASED', 'CONFLICTED')),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  unique (source_hr_request_id, item_id)
);

create table public.inventory_postings (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  posting_kind text not null check (posting_kind in ('OPENING', 'WAREHOUSE_SHIPMENT', 'REPLENISHMENT', 'RECEIPT', 'STOCKTAKE', 'CORRECTION', 'RETURN')),
  source_entity_id uuid not null,
  posted_by uuid not null references public.app_accounts(id),
  posted_at timestamptz not null default now()
);

create table public.inventory_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  posting_id uuid not null references public.inventory_postings(id),
  line_no integer not null check (line_no > 0),
  warehouse_id uuid not null references public.warehouses(id),
  item_id uuid not null references public.uniform_items(id),
  movement_kind text not null,
  quantity_delta bigint not null,
  occurred_on date not null,
  unique (posting_id, line_no)
);

create or replace function private.require_hr_request_snapshots()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  request_status public.hr_request_status;
begin
  select status into request_status
  from public.hr_requests
  where id = new.request_id;
  if request_status is distinct from 'DRAFT' then
    raise exception 'HR issue lines can only be edited while the request is DRAFT';
  end if;
  return new;
end;
$$;

create trigger hr_issue_lines_snapshot_guard
before insert or update on public.hr_issue_lines
for each row execute function private.require_hr_request_snapshots();

create or replace function private.require_hr_item_snapshots()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  request_status public.hr_request_status;
begin
  select status into request_status
  from public.hr_requests
  where id = new.request_id;
  if request_status is distinct from 'DRAFT' then
    raise exception 'HR request items can only be edited while the request is DRAFT';
  end if;
  return new;
end;
$$;

create trigger hr_request_items_snapshot_guard
before insert or update on public.hr_request_items
for each row execute function private.require_hr_item_snapshots();

create or replace function private.prevent_hr_request_reparent()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  if old.request_id <> new.request_id then
    raise exception 'A request line cannot be moved to another HR request';
  end if;
  return new;
end;
$$;

create trigger hr_issue_lines_reparent_guard
before update on public.hr_issue_lines
for each row execute function private.prevent_hr_request_reparent();

create trigger hr_request_items_reparent_guard
before update on public.hr_request_items
for each row execute function private.prevent_hr_request_reparent();

create or replace function private.bump_hr_request_version()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  update public.hr_requests
  set row_version = row_version + 1
  where id = case when tg_op = 'DELETE' then old.request_id else new.request_id end;
  return null;
end;
$$;

create trigger hr_issue_lines_version_bump
after insert or update or delete on public.hr_issue_lines
for each row execute function private.bump_hr_request_version();

create trigger hr_request_items_version_bump
after insert or update or delete on public.hr_request_items
for each row execute function private.bump_hr_request_version();

create or replace function private.validate_hr_request_submission()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  if old.status = 'DRAFT' and new.status <> 'DRAFT' then
    if exists (
      select 1 from public.hr_issue_lines l
      where l.request_id = new.id
        and (l.employee_no_snapshot is null or l.employee_name_snapshot is null
          or l.institution_id_snapshot is null or l.institution_code_snapshot is null
          or l.institution_name_snapshot is null or l.department_id_snapshot is null
          or l.department_code_snapshot is null or l.department_name_snapshot is null
          or l.item_code_snapshot is null or l.item_name_snapshot is null
          or l.unit_snapshot is null)
    ) then
      raise exception 'Submitted HR requests require complete issue-line snapshots';
    end if;
    if exists (
      select 1 from public.hr_request_items r
      where r.request_id = new.id
        and (r.item_code_snapshot is null or r.item_name_snapshot is null or r.unit_snapshot is null)
    ) then
      raise exception 'Submitted HR requests require complete item snapshots';
    end if;
    if exists (
      select 1
      from public.hr_issue_lines l
      left join public.hr_request_items r
        on r.request_id = l.request_id and r.item_id = l.item_id
      where l.request_id = new.id and r.id is null
    ) then
      raise exception 'Every employee issue line must have a matching request item summary';
    end if;
  end if;
  return new;
end;
$$;

create trigger hr_request_submission_guard
before update of status on public.hr_requests
for each row execute function private.validate_hr_request_submission();

create or replace function private.current_account_id()
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, private
as $$
  select id
  from public.app_accounts
  where auth_user_id = auth.uid()
    and is_active
  limit 1
$$;

create or replace function private.has_role(required_role public.app_role)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, private
as $$
  select exists (
    select 1
    from public.user_roles ur
    where ur.account_id = private.current_account_id()
      and ur.role_code = required_role
  )
$$;

create or replace function public.submit_hr_request(
  p_request_id uuid,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.hr_requests
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  request_row public.hr_requests;
  command_row public.operation_commands;
  item_row record;
  item_id_row record;
  current_account uuid;
  locked_item_ids uuid[];
  current_item_ids uuid[];
  combined_on_hand bigint;
  active_reserved bigint;
  issue_sum bigint;
begin
  current_account := private.current_account_id();
  if auth.uid() is null
     or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null
     or not private.has_role('HR') then
    raise exception using errcode = '42501', message = 'HR role is required';
  end if;
  if btrim(coalesce(p_idempotency_key, '')) = '' or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'idempotency_key and request_fingerprint are required';
  end if;

  insert into public.operation_commands (
    operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id
  ) values (
    'SUBMIT_HR_REQUEST', p_idempotency_key, p_request_fingerprint, current_account
  ) on conflict (operation_code, idempotency_key) do nothing
  returning * into command_row;

  if command_row.id is null then
    select * into command_row
    from public.operation_commands
    where operation_code = 'SUBMIT_HR_REQUEST'
      and idempotency_key = p_idempotency_key
    for update;
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' and command_row.result_entity_id = p_request_id then
      select * into request_row from public.hr_requests where id = p_request_id;
      return request_row;
    end if;
    raise exception using errcode = '40001', message = 'request is already in progress or failed';
  end if;

  -- Global lock order: operation command -> item mutexes -> source request -> balances -> reservations.
  select coalesce(array_agg(item_id order by item_id), '{}'::uuid[])
    into locked_item_ids
  from (
    select distinct item_id
    from public.hr_request_items
    where request_id = p_request_id
  ) requested_items;
  if cardinality(locked_item_ids) = 0 then
    raise exception 'At least one request item is required';
  end if;

  insert into public.inventory_item_locks (item_id)
  select item_id
  from unnest(locked_item_ids) as requested(item_id)
  order by item_id
  on conflict (item_id) do nothing;

  for item_id_row in
    select item_id from unnest(locked_item_ids) as requested(item_id) order by item_id
  loop
    perform 1 from public.inventory_item_locks where item_id = item_id_row.item_id for update;
  end loop;

  select * into request_row
  from public.hr_requests
  where id = p_request_id
  for update;

  if request_row.id is null then
    raise exception 'HR request does not exist';
  end if;
  if request_row.created_by <> current_account then
    raise exception using errcode = '42501', message = 'Only the request owner can submit this draft';
  end if;
  if request_row.status <> 'DRAFT' then
    raise exception 'Only DRAFT requests can be submitted';
  end if;

  select coalesce(array_agg(item_id order by item_id), '{}'::uuid[])
    into current_item_ids
  from (
    select distinct item_id
    from public.hr_request_items
    where request_id = p_request_id
  ) current_items;
  if current_item_ids is distinct from locked_item_ids then
    raise exception using errcode = '40001', message = 'Request items changed while submission was locking; retry';
  end if;

  if exists (
    select 1
    from public.hr_issue_lines l
    join public.employees e on e.id = l.employee_id
    join public.uniform_items ui on ui.id = l.item_id
    where l.request_id = p_request_id
      and (e.employment_status <> 'ACTIVE' or not ui.is_active)
  ) then
    raise exception 'Only active employees and uniform items may be submitted';
  end if;

  if exists (
    select 1
    from public.hr_issue_lines l
    left join public.hr_request_items r
      on r.request_id = l.request_id and r.item_id = l.item_id
    where l.request_id = p_request_id and r.id is null
  ) then
    raise exception 'Every employee issue line must have a matching request item summary';
  end if;

  update public.hr_issue_lines l
  set employee_no_snapshot = e.employee_no,
      employee_name_snapshot = e.name,
      institution_id_snapshot = e.institution_id,
      institution_code_snapshot = i.code,
      institution_name_snapshot = i.name,
      department_id_snapshot = e.department_id,
      department_code_snapshot = d.code,
      department_name_snapshot = d.name,
      item_code_snapshot = ui.item_code,
      item_name_snapshot = ui.item_name,
      size_snapshot = ui.size,
      unit_snapshot = ui.unit
  from public.employees e
  join public.institutions i on i.id = e.institution_id
  join public.departments d on d.id = e.department_id and d.institution_id = e.institution_id
  join public.uniform_items ui on ui.id = l.item_id
  where l.request_id = p_request_id and l.employee_id = e.id;

  update public.hr_request_items r
  set item_code_snapshot = ui.item_code,
      item_name_snapshot = ui.item_name,
      unit_snapshot = ui.unit
  from public.uniform_items ui
  where r.request_id = p_request_id and r.item_id = ui.id;

  for item_row in
    select * from public.hr_request_items where request_id = p_request_id order by item_id for update
  loop
    perform 1
    from public.inventory_balances b
    join public.warehouses w on w.id = b.warehouse_id
    where b.item_id = item_row.item_id
      and w.is_active
      and w.purpose in ('HR', 'GENERAL')
    order by b.warehouse_id
    for update;

    select coalesce(sum(b.on_hand_quantity), 0)
      into combined_on_hand
    from public.inventory_balances b
    join public.warehouses w on w.id = b.warehouse_id
    where b.item_id = item_row.item_id
      and w.is_active
      and w.purpose in ('HR', 'GENERAL');

    perform 1 from public.inventory_reservations r
    where r.item_id = item_row.item_id and r.status = 'ACTIVE'
    order by r.source_hr_request_id, r.id
    for update;

    select coalesce(sum(r.quantity), 0)
      into active_reserved
    from public.inventory_reservations r
    where r.item_id = item_row.item_id and r.status = 'ACTIVE';

    select coalesce(sum(l.quantity), 0)
      into issue_sum
    from public.hr_issue_lines l
    where l.request_id = p_request_id and l.item_id = item_row.item_id;

    if issue_sum <> item_row.issue_quantity then
      raise exception 'Issue summary does not match employee lines for item %', item_row.item_id;
    end if;
    if item_row.requested_transfer_quantity > combined_on_hand - active_reserved then
      raise exception 'Requested quantity exceeds available stock for item %', item_row.item_id;
    end if;

    insert into public.inventory_reservations (source_hr_request_id, item_id, quantity)
    values (p_request_id, item_row.item_id, item_row.requested_transfer_quantity);
  end loop;

  update public.hr_requests
  set status = 'SUBMITTED',
      submitted_at = now(),
      submitted_by = current_account,
      row_version = row_version + 1
  where id = p_request_id
  returning * into request_row;

  update public.operation_commands
  set status = 'SUCCEEDED',
      result_entity_type = 'hr_requests',
      result_entity_id = p_request_id,
      succeeded_at = now()
  where id = command_row.id;

  return request_row;
end;
$$;

revoke all on function public.submit_hr_request(uuid, text, text) from public, anon;
grant execute on function public.submit_hr_request(uuid, text, text) to authenticated;

alter table public.app_accounts enable row level security;
alter table public.user_roles enable row level security;
alter table public.operation_commands enable row level security;
alter table public.institutions enable row level security;
alter table public.departments enable row level security;
alter table public.coordinator_scopes enable row level security;
alter table public.employees enable row level security;
alter table public.uniform_items enable row level security;
alter table public.suppliers enable row level security;
alter table public.supplier_uniform_items enable row level security;
alter table public.warehouses enable row level security;
alter table public.inventory_balances enable row level security;
alter table public.inventory_item_locks enable row level security;
alter table public.hr_requests enable row level security;
alter table public.hr_issue_lines enable row level security;
alter table public.hr_request_items enable row level security;
alter table public.inventory_reservations enable row level security;
alter table public.inventory_postings enable row level security;
alter table public.inventory_ledger_entries enable row level security;

create policy app_accounts_self_read on public.app_accounts
  for select to authenticated using (auth_user_id = auth.uid());
create policy user_roles_self_read on public.user_roles
  for select to authenticated using (account_id = private.current_account_id());

create policy coordinator_scopes_read on public.coordinator_scopes
  for select to authenticated using (
    private.has_role('HR')
    or (private.has_role('DEMAND_COORDINATOR') and account_id = private.current_account_id())
  );

drop policy if exists institutions_active_read on public.institutions;
create policy institutions_active_read on public.institutions
  for select to authenticated using (
    is_active and (
      private.has_role('SYSTEM_ADMIN') or private.has_role('HR') or private.has_role('WAREHOUSE')
      or private.has_role('PROCUREMENT') or private.has_role('CEO')
      or exists (
        select 1 from public.coordinator_scopes cs
        where private.has_role('DEMAND_COORDINATOR')
          and cs.account_id = private.current_account_id() and cs.institution_id = institutions.id
      )
    )
  );
drop policy if exists departments_active_read on public.departments;
create policy departments_active_read on public.departments
  for select to authenticated using (
    is_active and (
      private.has_role('SYSTEM_ADMIN') or private.has_role('HR') or private.has_role('WAREHOUSE')
      or private.has_role('PROCUREMENT') or private.has_role('CEO')
      or exists (
        select 1 from public.coordinator_scopes cs
        where private.has_role('DEMAND_COORDINATOR')
          and cs.account_id = private.current_account_id()
          and cs.institution_id = departments.institution_id
          and cs.department_id = departments.id
      )
    )
  );
create policy employees_authorized_read on public.employees
  for select to authenticated using (
    private.has_role('HR') or private.has_role('WAREHOUSE')
    or exists (
      select 1 from public.coordinator_scopes cs
      where private.has_role('DEMAND_COORDINATOR')
        and cs.account_id = private.current_account_id()
        and cs.institution_id = employees.institution_id
        and cs.department_id = employees.department_id
    )
  );
create policy uniform_items_active_read on public.uniform_items
  for select to authenticated using (is_active and private.current_account_id() is not null);
create policy suppliers_authorized_read on public.suppliers
  for select to authenticated using (
    private.has_role('HR') or private.has_role('PROCUREMENT') or private.has_role('WAREHOUSE')
    or private.has_role('CEO')
  );
create policy supplier_uniform_items_authorized_read on public.supplier_uniform_items
  for select to authenticated using (
    private.has_role('HR') or private.has_role('PROCUREMENT') or private.has_role('WAREHOUSE')
    or private.has_role('CEO')
  );
create policy warehouses_active_read on public.warehouses
  for select to authenticated using (is_active and (private.has_role('HR') or private.has_role('WAREHOUSE')));
create policy inventory_balances_read on public.inventory_balances
  for select to authenticated using (private.has_role('HR') or private.has_role('WAREHOUSE'));
create policy hr_requests_read on public.hr_requests
  for select to authenticated using (private.has_role('HR') or private.has_role('WAREHOUSE'));
create policy hr_issue_lines_read on public.hr_issue_lines
  for select to authenticated using (private.has_role('HR') or private.has_role('WAREHOUSE'));
create policy hr_request_items_read on public.hr_request_items
  for select to authenticated using (private.has_role('HR') or private.has_role('WAREHOUSE'));

create policy hr_requests_draft_insert on public.hr_requests
  for insert to authenticated with check (
    private.has_role('HR') and created_by = private.current_account_id() and status = 'DRAFT'
  );
create policy hr_requests_draft_update on public.hr_requests
  for update to authenticated using (
    private.has_role('HR') and created_by = private.current_account_id() and status = 'DRAFT'
  ) with check (
    private.has_role('HR') and created_by = private.current_account_id() and status = 'DRAFT'
  );
create policy hr_issue_lines_draft_insert on public.hr_issue_lines
  for insert to authenticated with check (exists (
    select 1 from public.hr_requests r
    where r.id = request_id and r.created_by = private.current_account_id() and r.status = 'DRAFT'
      and private.has_role('HR')
  ));
create policy hr_issue_lines_draft_update on public.hr_issue_lines
  for update to authenticated using (exists (
    select 1 from public.hr_requests r
    where r.id = request_id and r.created_by = private.current_account_id() and r.status = 'DRAFT'
      and private.has_role('HR')
  )) with check (exists (
    select 1 from public.hr_requests r
    where r.id = request_id and r.created_by = private.current_account_id() and r.status = 'DRAFT'
      and private.has_role('HR')
  ));
create policy hr_request_items_draft_insert on public.hr_request_items
  for insert to authenticated with check (exists (
    select 1 from public.hr_requests r
    where r.id = request_id and r.created_by = private.current_account_id() and r.status = 'DRAFT'
      and private.has_role('HR')
  ));
create policy hr_request_items_draft_update on public.hr_request_items
  for update to authenticated using (exists (
    select 1 from public.hr_requests r
    where r.id = request_id and r.created_by = private.current_account_id() and r.status = 'DRAFT'
      and private.has_role('HR')
  )) with check (exists (
    select 1 from public.hr_requests r
    where r.id = request_id and r.created_by = private.current_account_id() and r.status = 'DRAFT'
      and private.has_role('HR')
  ));
create policy inventory_reservations_read on public.inventory_reservations
  for select to authenticated using (private.has_role('HR') or private.has_role('WAREHOUSE'));
create policy inventory_postings_read on public.inventory_postings
  for select to authenticated using (private.has_role('HR') or private.has_role('WAREHOUSE'));
create policy inventory_ledger_entries_read on public.inventory_ledger_entries
  for select to authenticated using (private.has_role('HR') or private.has_role('WAREHOUSE'));

-- No direct writes to operation commands, locks, reservations, balances or ledger entries.
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;
revoke all on function private.current_account_id() from public, anon;
revoke all on function private.has_role(public.app_role) from public, anon;
grant execute on function private.current_account_id() to authenticated;
grant execute on function private.has_role(public.app_role) to authenticated;

revoke all on all tables in schema public from public, anon, authenticated;
alter default privileges in schema public revoke all on tables from public, anon, authenticated;
alter default privileges in schema public revoke all on sequences from public, anon, authenticated;
alter default privileges in schema public revoke all on functions from public, anon, authenticated;
alter default privileges in schema private revoke all on functions from public, anon, authenticated;
grant select on public.app_accounts, public.user_roles, public.institutions, public.departments,
  public.coordinator_scopes, public.employees, public.uniform_items, public.suppliers,
  public.supplier_uniform_items, public.warehouses, public.inventory_balances,
  public.hr_requests, public.hr_issue_lines, public.hr_request_items,
  public.inventory_reservations, public.inventory_postings, public.inventory_ledger_entries
  to authenticated;
grant insert, update on public.hr_requests, public.hr_issue_lines, public.hr_request_items to authenticated;
