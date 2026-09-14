-- Seasonal demand, CEO approval, MOQ decisions and purchase receipt foundation.

create table public.seasonal_campaigns (
  id uuid primary key default gen_random_uuid(),
  campaign_no text not null unique check (btrim(campaign_no) <> ''),
  name text not null check (btrim(name) <> ''),
  season text not null check (btrim(season) <> ''),
  status text not null default 'DRAFT' check (status in ('DRAFT', 'OPEN', 'HR_REVIEW', 'PENDING_APPROVAL', 'APPROVED', 'CLOSED')),
  window_start date not null,
  window_end date not null,
  opens_at timestamptz not null,
  closes_at timestamptz not null,
  created_by uuid not null references public.app_accounts(id),
  approved_at timestamptz,
  closed_at timestamptz,
  check (window_end >= window_start),
  check (closes_at > opens_at)
);

create table public.seasonal_campaign_employees (
  campaign_id uuid not null references public.seasonal_campaigns(id),
  employee_id uuid not null references public.employees(id),
  employee_no_snapshot text not null,
  employee_name_snapshot text not null,
  institution_id_snapshot uuid not null,
  department_id_snapshot uuid not null,
  unique (campaign_id, employee_id)
);

create table public.seasonal_campaign_items (
  campaign_id uuid not null references public.seasonal_campaigns(id),
  item_id uuid not null references public.uniform_items(id),
  item_code_snapshot text not null,
  item_name_snapshot text not null,
  unit_snapshot text not null,
  unique (campaign_id, item_id)
);

create table public.seasonal_demand_lines (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.seasonal_campaigns(id),
  employee_id uuid not null references public.employees(id),
  item_id uuid not null references public.uniform_items(id),
  quantity bigint not null check (quantity >= 0),
  entered_by uuid not null references public.app_accounts(id),
  updated_by uuid not null references public.app_accounts(id),
  hr_modified boolean not null default false,
  hr_note text,
  employee_no_snapshot text,
  employee_name_snapshot text,
  institution_code_snapshot text,
  department_code_snapshot text,
  item_code_snapshot text,
  item_name_snapshot text,
  size_snapshot text,
  unit_snapshot text,
  updated_at timestamptz not null default now(),
  unique (campaign_id, employee_id, item_id)
);

create table public.seasonal_approval_submissions (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.seasonal_campaigns(id),
  revision integer not null check (revision > 0),
  status text not null default 'PENDING' check (status in ('PENDING', 'RETURNED', 'APPROVED')),
  demand_snapshot_hash text not null,
  submitted_at timestamptz not null default now(),
  submitted_by uuid not null references public.app_accounts(id),
  unique (campaign_id, revision)
);

create table public.seasonal_approval_submission_lines (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.seasonal_approval_submissions(id),
  item_id uuid not null references public.uniform_items(id),
  demand_quantity_snapshot bigint not null check (demand_quantity_snapshot >= 0),
  item_code_snapshot text not null,
  item_name_snapshot text not null,
  size_snapshot text,
  unit_snapshot text not null,
  unique (submission_id, item_id)
);

create table public.seasonal_approvals (
  id uuid primary key default gen_random_uuid(),
  approval_no text not null unique check (btrim(approval_no) <> ''),
  campaign_id uuid not null unique references public.seasonal_campaigns(id),
  submission_id uuid not null unique references public.seasonal_approval_submissions(id),
  status text not null default 'APPROVED' check (status in ('APPROVED')),
  demand_snapshot_hash text not null,
  approved_at timestamptz not null default now(),
  approved_by uuid not null references public.app_accounts(id)
);

create table public.seasonal_approval_lines (
  id uuid primary key default gen_random_uuid(),
  approval_id uuid not null references public.seasonal_approvals(id),
  item_id uuid not null references public.uniform_items(id),
  demand_quantity_snapshot bigint not null check (demand_quantity_snapshot >= 0),
  approved_quantity bigint not null check (approved_quantity >= 0),
  item_code_snapshot text not null,
  item_name_snapshot text not null,
  size_snapshot text,
  unit_snapshot text not null,
  unique (approval_id, item_id),
  unique (id, item_id)
);

create table public.seasonal_procurement_lines (
  id uuid primary key default gen_random_uuid(),
  approval_line_id uuid not null,
  item_id uuid not null,
  supplier_id uuid not null references public.suppliers(id),
  approved_quantity_snapshot bigint not null check (approved_quantity_snapshot >= 0),
  minimum_order_quantity_snapshot bigint check (minimum_order_quantity_snapshot is null or minimum_order_quantity_snapshot > 0),
  final_purchase_quantity bigint not null check (final_purchase_quantity >= 0),
  difference_reason text,
  note text,
  decided_at timestamptz not null default now(),
  decided_by uuid not null references public.app_accounts(id),
  unique (approval_line_id),
  unique (id, item_id),
  foreign key (approval_line_id, item_id)
    references public.seasonal_approval_lines(id, item_id),
  foreign key (supplier_id, item_id)
    references public.supplier_uniform_items(supplier_id, item_id)
);

create table public.seasonal_procurement_line_changes (
  id uuid primary key default gen_random_uuid(),
  procurement_line_id uuid not null references public.seasonal_procurement_lines(id),
  revision integer not null check (revision > 0),
  old_purchase_limit_quantity bigint not null check (old_purchase_limit_quantity >= 0),
  new_purchase_limit_quantity bigint not null check (new_purchase_limit_quantity >= 0),
  reason text not null check (btrim(reason) <> ''),
  changed_at timestamptz not null default now(),
  changed_by uuid not null references public.app_accounts(id),
  unique (procurement_line_id, revision)
);

create table public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  po_no text not null unique check (btrim(po_no) <> ''),
  supplier_id uuid not null references public.suppliers(id),
  supplier_code_snapshot text not null,
  supplier_name_snapshot text not null,
  status text not null default 'DRAFT' check (status in ('DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'REOPENED', 'CLOSED_SHORT', 'CANCELLED')),
  order_date date,
  expected_arrival_date date,
  currency char(3),
  created_by uuid not null references public.app_accounts(id),
  ordered_at timestamptz,
  ordered_by uuid references public.app_accounts(id),
  closed_at timestamptz,
  closed_by uuid references public.app_accounts(id),
  close_reason text,
  cancelled_at timestamptz,
  cancelled_by uuid references public.app_accounts(id),
  cancel_reason text,
  note text
);

create table public.purchase_order_lines (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references public.purchase_orders(id),
  line_no integer not null check (line_no > 0),
  seasonal_procurement_line_id uuid not null,
  item_id uuid not null,
  item_code_snapshot text not null,
  item_name_snapshot text not null,
  size_snapshot text,
  unit_snapshot text not null,
  initial_ordered_quantity_snapshot bigint,
  ordered_quantity bigint not null check (ordered_quantity >= 0),
  unit_price_ex_tax numeric(14, 4),
  tax_rate numeric(8, 5),
  unique (purchase_order_id, line_no),
  unique (purchase_order_id, id),
  foreign key (seasonal_procurement_line_id, item_id)
    references public.seasonal_procurement_lines(id, item_id)
);

create table public.purchase_receipts (
  id uuid primary key default gen_random_uuid(),
  receipt_no text not null unique check (btrim(receipt_no) <> ''),
  purchase_order_id uuid not null references public.purchase_orders(id),
  status text not null default 'DRAFT' check (status in ('DRAFT', 'POSTED')),
  received_on date not null,
  created_by uuid not null references public.app_accounts(id),
  posted_at timestamptz,
  posted_by uuid references public.app_accounts(id),
  note text,
  unique (id, purchase_order_id)
);

create table public.purchase_receipt_lines (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null,
  purchase_order_id uuid not null,
  purchase_order_line_id uuid not null,
  item_id uuid not null,
  delivered_quantity bigint not null check (delivered_quantity > 0),
  accepted_quantity bigint not null check (accepted_quantity >= 0),
  rejected_quantity bigint not null check (rejected_quantity >= 0),
  rejection_reason text,
  item_code_snapshot text not null,
  item_name_snapshot text not null,
  unique (receipt_id, purchase_order_line_id),
  foreign key (receipt_id, purchase_order_id)
    references public.purchase_receipts(id, purchase_order_id),
  foreign key (purchase_order_id, purchase_order_line_id)
    references public.purchase_order_lines(purchase_order_id, id),
  check (accepted_quantity + rejected_quantity = delivered_quantity),
  check (rejected_quantity = 0 or btrim(coalesce(rejection_reason, '')) <> '')
);

alter table public.seasonal_campaigns enable row level security;
alter table public.seasonal_campaign_employees enable row level security;
alter table public.seasonal_campaign_items enable row level security;
alter table public.seasonal_demand_lines enable row level security;
alter table public.seasonal_approval_submissions enable row level security;
alter table public.seasonal_approval_submission_lines enable row level security;
alter table public.seasonal_approvals enable row level security;
alter table public.seasonal_approval_lines enable row level security;
alter table public.seasonal_procurement_lines enable row level security;
alter table public.seasonal_procurement_line_changes enable row level security;
alter table public.purchase_orders enable row level security;
alter table public.purchase_order_lines enable row level security;
alter table public.purchase_receipts enable row level security;
alter table public.purchase_receipt_lines enable row level security;

create policy seasonal_campaigns_read on public.seasonal_campaigns
  for select to authenticated using (
    private.has_role('HR') or private.has_role('CEO') or private.has_role('PROCUREMENT')
    or private.has_role('DEMAND_COORDINATOR')
  );
create policy seasonal_campaign_scope_read on public.seasonal_campaign_employees
  for select to authenticated using (
    private.has_role('HR') or private.has_role('CEO') or private.has_role('PROCUREMENT')
    or (private.has_role('DEMAND_COORDINATOR') and exists (
      select 1 from public.coordinator_scopes cs
      join public.employees e on e.id = seasonal_campaign_employees.employee_id
      where cs.account_id = private.current_account_id()
        and cs.institution_id = e.institution_id and cs.department_id = e.department_id
    ))
  );
create policy seasonal_campaign_items_read on public.seasonal_campaign_items
  for select to authenticated using (
    private.has_role('HR') or private.has_role('CEO') or private.has_role('PROCUREMENT')
    or private.has_role('DEMAND_COORDINATOR')
  );
create policy seasonal_demand_lines_read on public.seasonal_demand_lines
  for select to authenticated using (
    private.has_role('HR') or private.has_role('CEO') or private.has_role('PROCUREMENT')
    or (private.has_role('DEMAND_COORDINATOR') and exists (
      select 1 from public.coordinator_scopes cs
      join public.employees e on e.id = seasonal_demand_lines.employee_id
      where cs.account_id = private.current_account_id()
        and cs.institution_id = e.institution_id and cs.department_id = e.department_id
    ))
  );
create policy seasonal_demand_lines_draft_write on public.seasonal_demand_lines
  for insert to authenticated with check (
    private.has_role('DEMAND_COORDINATOR') and exists (
      select 1 from public.coordinator_scopes cs
      join public.employees e on e.id = employee_id
      where cs.account_id = private.current_account_id()
        and cs.institution_id = e.institution_id and cs.department_id = e.department_id
        and e.employment_status = 'ACTIVE'
    ) and exists (
      select 1 from public.seasonal_campaign_employees ce
      where ce.campaign_id = seasonal_demand_lines.campaign_id
        and ce.employee_id = seasonal_demand_lines.employee_id
    ) and exists (
      select 1 from public.seasonal_campaign_items ci
      where ci.campaign_id = seasonal_demand_lines.campaign_id
        and ci.item_id = seasonal_demand_lines.item_id
    ) and exists (
      select 1 from public.uniform_items i
      where i.id = item_id and i.is_active
    ) and exists (
      select 1 from public.seasonal_campaigns sc
      where sc.id = campaign_id and sc.status = 'OPEN'
        and current_timestamp between sc.opens_at and sc.closes_at
    )
  );
create policy seasonal_demand_lines_window_update on public.seasonal_demand_lines
  for update to authenticated
  using (
    private.has_role('DEMAND_COORDINATOR') and exists (
      select 1 from public.coordinator_scopes cs
      join public.employees e on e.id = seasonal_demand_lines.employee_id
      where cs.account_id = private.current_account_id()
        and cs.institution_id = e.institution_id and cs.department_id = e.department_id
    ) and exists (
      select 1 from public.seasonal_campaigns sc
      where sc.id = seasonal_demand_lines.campaign_id and sc.status = 'OPEN'
        and current_timestamp between sc.opens_at and sc.closes_at
    )
  )
  with check (
    private.has_role('DEMAND_COORDINATOR') and exists (
      select 1 from public.coordinator_scopes cs
      join public.employees e on e.id = employee_id
      where cs.account_id = private.current_account_id()
        and cs.institution_id = e.institution_id and cs.department_id = e.department_id
        and e.employment_status = 'ACTIVE'
    ) and exists (
      select 1 from public.seasonal_campaign_employees ce
      where ce.campaign_id = seasonal_demand_lines.campaign_id
        and ce.employee_id = seasonal_demand_lines.employee_id
    ) and exists (
      select 1 from public.seasonal_campaign_items ci
      where ci.campaign_id = seasonal_demand_lines.campaign_id
        and ci.item_id = seasonal_demand_lines.item_id
    ) and exists (
      select 1 from public.uniform_items i
      where i.id = item_id and i.is_active
    ) and exists (
      select 1 from public.seasonal_campaigns sc
      where sc.id = campaign_id and sc.status = 'OPEN'
        and current_timestamp between sc.opens_at and sc.closes_at
    )
  );
create policy seasonal_demand_lines_hr_update on public.seasonal_demand_lines
  for update to authenticated using (
    private.has_role('HR') and exists (
      select 1 from public.seasonal_campaigns sc
      where sc.id = seasonal_demand_lines.campaign_id and sc.status = 'HR_REVIEW'
    )
  ) with check (
    private.has_role('HR') and exists (
      select 1 from public.seasonal_campaigns sc
      where sc.id = campaign_id and sc.status = 'HR_REVIEW'
    )
  );

create policy seasonal_approval_read on public.seasonal_approval_submissions
  for select to authenticated using (private.has_role('HR') or private.has_role('CEO') or private.has_role('PROCUREMENT'));
create policy seasonal_approval_submission_lines_read on public.seasonal_approval_submission_lines
  for select to authenticated using (private.has_role('HR') or private.has_role('CEO') or private.has_role('PROCUREMENT'));
create policy seasonal_approvals_read on public.seasonal_approvals
  for select to authenticated using (private.has_role('HR') or private.has_role('CEO') or private.has_role('PROCUREMENT'));
create policy seasonal_approval_lines_read on public.seasonal_approval_lines
  for select to authenticated using (private.has_role('HR') or private.has_role('CEO') or private.has_role('PROCUREMENT'));
create policy seasonal_procurement_read on public.seasonal_procurement_lines
  for select to authenticated using (private.has_role('HR') or private.has_role('CEO') or private.has_role('PROCUREMENT'));
create policy seasonal_procurement_changes_read on public.seasonal_procurement_line_changes
  for select to authenticated using (private.has_role('HR') or private.has_role('CEO') or private.has_role('PROCUREMENT'));
create policy purchase_orders_read on public.purchase_orders
  for select to authenticated using (private.has_role('HR') or private.has_role('CEO') or private.has_role('PROCUREMENT') or private.has_role('WAREHOUSE'));
create policy purchase_order_lines_read on public.purchase_order_lines
  for select to authenticated using (private.has_role('HR') or private.has_role('CEO') or private.has_role('PROCUREMENT') or private.has_role('WAREHOUSE'));
create policy purchase_receipts_read on public.purchase_receipts
  for select to authenticated using (private.has_role('HR') or private.has_role('CEO') or private.has_role('PROCUREMENT') or private.has_role('WAREHOUSE'));
create policy purchase_receipt_lines_read on public.purchase_receipt_lines
  for select to authenticated using (private.has_role('HR') or private.has_role('CEO') or private.has_role('PROCUREMENT') or private.has_role('WAREHOUSE'));

revoke all on table public.seasonal_campaigns, public.seasonal_campaign_employees,
  public.seasonal_campaign_items, public.seasonal_demand_lines,
  public.seasonal_approval_submissions, public.seasonal_approval_submission_lines,
  public.seasonal_approvals, public.seasonal_approval_lines,
  public.seasonal_procurement_lines, public.seasonal_procurement_line_changes,
  public.purchase_orders, public.purchase_order_lines,
  public.purchase_receipts, public.purchase_receipt_lines
  from public, anon, authenticated;
grant select on public.seasonal_campaigns, public.seasonal_campaign_employees,
  public.seasonal_campaign_items, public.seasonal_demand_lines,
  public.seasonal_approval_submissions, public.seasonal_approval_submission_lines,
  public.seasonal_approvals, public.seasonal_approval_lines,
  public.seasonal_procurement_lines, public.seasonal_procurement_line_changes,
  public.purchase_orders, public.purchase_order_lines,
  public.purchase_receipts, public.purchase_receipt_lines to authenticated;
grant insert, update on public.seasonal_demand_lines to authenticated;
