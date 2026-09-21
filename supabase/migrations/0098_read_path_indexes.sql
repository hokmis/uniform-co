-- Read-path indexes for the active workspaces.
-- These indexes do not change workflow rules, RLS, or append-only guarantees.
-- They cover the filters and orderings used by the browser workbenches.

create index if not exists institutions_active_code_idx
  on public.institutions (code)
  where is_active;

create index if not exists departments_active_institution_code_idx
  on public.departments (institution_id, code)
  where is_active;

create index if not exists employees_active_employee_no_idx
  on public.employees (employee_no)
  where employment_status = 'ACTIVE';

create index if not exists uniform_items_active_code_idx
  on public.uniform_items (item_code)
  where is_active;

create index if not exists suppliers_active_code_idx
  on public.suppliers (supplier_code)
  where is_active;

create index if not exists inventory_reservations_active_item_idx
  on public.inventory_reservations (item_id)
  where status = 'ACTIVE';

create index if not exists hr_requests_status_created_at_idx
  on public.hr_requests (status, created_at desc);

create index if not exists warehouse_shipments_status_request_idx
  on public.warehouse_shipments (status, hr_request_id);

create index if not exists replenishment_requests_status_submitted_at_idx
  on public.replenishment_requests (status, submitted_at desc);

create index if not exists seasonal_campaigns_status_closes_at_idx
  on public.seasonal_campaigns (status, closes_at);

create index if not exists seasonal_campaign_employees_campaign_employee_no_idx
  on public.seasonal_campaign_employees (campaign_id, employee_no_snapshot);

create index if not exists seasonal_campaign_items_campaign_item_code_idx
  on public.seasonal_campaign_items (campaign_id, item_code_snapshot);

create index if not exists seasonal_demand_lines_campaign_employee_item_idx
  on public.seasonal_demand_lines (campaign_id, employee_no_snapshot, item_code_snapshot);

create index if not exists seasonal_approval_submissions_status_submitted_at_idx
  on public.seasonal_approval_submissions (status, submitted_at desc);

create index if not exists seasonal_approval_submission_lines_submission_item_code_idx
  on public.seasonal_approval_submission_lines (submission_id, item_code_snapshot);

create index if not exists inventory_ledger_entries_warehouse_item_date_idx
  on public.inventory_ledger_entries (warehouse_id, item_id, occurred_on desc);
