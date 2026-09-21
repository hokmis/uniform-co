-- GENERATED FILE. Do not edit directly.

-- Regenerate with: node scripts/database/generate-production-read-model-sql.mjs

-- Source of truth: the versioned migrations listed below.

-- This transaction changes schema objects only; it does not insert, update, or delete business rows.

-- Migration ledger note: executing in SQL Editor does not reconcile supabase_migrations.schema_migrations.

-- Do not run `supabase db push` until the remote migration history has been reconciled against the actual schema.



begin;

-- Verify that this database has the base schema these forward migrations depend on.
do $read_model_preflight$
declare
  missing_relations text;
  missing_functions text;
begin
  select string_agg(required.name, ', ' order by required.name)
    into missing_relations
  from (values
    ('app_accounts'),
    ('audit_events'),
    ('correction_notes'),
    ('departments'),
    ('employees'),
    ('hr_issue_lines'),
    ('hr_request_items'),
    ('hr_requests'),
    ('import_batches'),
    ('institutions'),
    ('inventory_balances'),
    ('inventory_item_locks'),
    ('inventory_reservations'),
    ('issue_correction_lines'),
    ('operation_commands'),
    ('purchase_order_lines'),
    ('purchase_orders'),
    ('purchase_receipt_correction_lines'),
    ('purchase_receipt_lines'),
    ('purchase_receipts'),
    ('replenishment_request_lines'),
    ('replenishment_requests'),
    ('return_correction_lines'),
    ('return_lines'),
    ('return_notes'),
    ('seasonal_approval_lines'),
    ('seasonal_approval_submissions'),
    ('seasonal_approvals'),
    ('seasonal_campaign_employees'),
    ('seasonal_campaign_items'),
    ('seasonal_campaigns'),
    ('seasonal_demand_lines'),
    ('seasonal_procurement_lines'),
    ('stocktake_lines'),
    ('stocktakes'),
    ('supplier_uniform_items'),
    ('suppliers'),
    ('uniform_items'),
    ('user_roles'),
    ('warehouse_shipment_lines'),
    ('warehouse_shipments'),
    ('warehouse_transfer_correction_lines'),
    ('warehouses'),
    ('v_item_availability'),
    ('v_hr_request_item_totals'),
    ('v_pending_warehouse_shipments'),
    ('v_purchase_order_receipt_progress')
  ) as required(name)
  where to_regclass('public.' || required.name) is null;

  if missing_relations is not null then
    raise exception using
      errcode = '55000',
      message = 'Read-model repair prerequisites are missing: ' || missing_relations;
  end if;

  select string_agg(required.signature, ', ' order by required.signature)
    into missing_functions
  from (values
    ('private.current_account_id()'),
    ('public.post_warehouse_shipment(uuid,text,text)'),
    ('public.create_seasonal_campaign(text,text,text,date,date,timestamptz,timestamptz,text,text)'),
    ('public.set_seasonal_campaign_scope(uuid,uuid[],uuid[],text,text)'),
    ('public.create_purchase_receipt_draft(text,uuid,bigint,bigint,bigint,text,date,text,text)'),
    ('public.post_purchase_receipt(uuid,text,text)'),
    ('public.create_stocktake_draft(text,uuid,text,jsonb,text,text)'),
    ('public.update_stocktake_draft(uuid,text,jsonb,boolean,text,text)'),
    ('public.post_stocktake(uuid,text,text)'),
    ('public.create_hr_request_draft(text,date,text,jsonb,jsonb,text,text)'),
    ('public.update_hr_request_draft(uuid,date,text,jsonb,jsonb,text,text)'),
    ('public.submit_hr_request(uuid,text,text)'),
    ('public.apply_master_import(text,text,jsonb,text,text)'),
    ('public.create_replenishment_draft(text,text,jsonb,text,text)'),
    ('public.update_replenishment_request_draft(uuid,text,jsonb,text,text)'),
    ('public.submit_replenishment_request(uuid,text,text)'),
    ('public.create_return_correction_draft(text,uuid,bigint,text,text,text,text)'),
    ('public.post_return_correction(uuid,text,text)'),
    ('public.create_hr_issue_correction_draft(text,uuid,bigint,text,text,text,text)'),
    ('public.post_hr_issue_correction(uuid,text,text)'),
    ('public.create_warehouse_transfer_correction_draft(text,text,uuid,bigint,text,text,text,text)'),
    ('public.post_warehouse_transfer_correction(uuid,text,text)'),
    ('public.create_purchase_receipt_correction_draft(text,uuid,bigint,bigint,bigint,text,text,text,text)'),
    ('public.post_purchase_receipt_correction(uuid,text,text)'),
    ('public.create_stocktake_correction_draft(text,uuid,bigint,text,text,text,text)'),
    ('public.post_stocktake_correction(uuid,text,text)'),
    ('public.create_return_note_draft(text,uuid,date,text,text,text,jsonb,text,text)'),
    ('public.post_return_note(uuid,text,text)')
  ) as required(signature)
  where to_regprocedure(required.signature) is null;

  if missing_functions is not null then
    raise exception using
      errcode = '55000',
      message = 'Read-model repair RPC prerequisites are missing: ' || missing_functions;
  end if;
end;
$read_model_preflight$;


-- Source: supabase/migrations/0099_hr_request_history_view.sql
-- Read path for the HR request history list.
-- Keep the view security-invoker so the existing table RLS policies remain
-- the authority for what HR/warehouse users can see.

create or replace view public.v_hr_request_history
with (security_invoker = true)
as
select
  r.id,
  r.request_no,
  r.status,
  r.distribution_date,
  r.row_version,
  r.created_at,
  r.submitted_at,
  r.shipped_at,
  r.cancelled_at,
  r.note,
  s.shipment_no,
  s.status as shipment_status,
  coalesce(sum(res.quantity) filter (where res.status = 'ACTIVE'), 0)::bigint
    as active_reserved_quantity
from public.hr_requests r
left join public.warehouse_shipments s on s.hr_request_id = r.id
left join public.inventory_reservations res on res.source_hr_request_id = r.id
group by
  r.id,
  r.request_no,
  r.status,
  r.distribution_date,
  r.row_version,
  r.created_at,
  r.submitted_at,
  r.shipped_at,
  r.cancelled_at,
  r.note,
  s.shipment_no,
  s.status;

revoke all on table public.v_hr_request_history from public, anon, authenticated;
grant select on public.v_hr_request_history to authenticated;

create index if not exists hr_requests_created_at_idx
  on public.hr_requests (created_at desc);

create index if not exists inventory_reservations_source_status_idx
  on public.inventory_reservations (source_hr_request_id, status)
  include (quantity);

-- Source: supabase/migrations/0100_reporting_join_indexes.sql
-- Read-path indexes for reporting joins and the dashboard activity feed.
-- These indexes are additive only: they do not change RLS, workflow state,
-- append-only guarantees, or the meaning of any business record.

create index if not exists inventory_balances_item_warehouse_read_idx
  on public.inventory_balances (item_id, warehouse_id)
  include (on_hand_quantity);

create index if not exists hr_issue_lines_request_item_read_idx
  on public.hr_issue_lines (request_id, item_id)
  include (quantity);

create index if not exists purchase_receipt_lines_order_line_read_idx
  on public.purchase_receipt_lines (purchase_order_line_id, receipt_id)
  include (delivered_quantity, accepted_quantity, rejected_quantity);

create index if not exists purchase_receipt_correction_lines_source_read_idx
  on public.purchase_receipt_correction_lines (original_receipt_line_id, correction_note_id)
  include (delivered_quantity_delta, accepted_quantity_delta, rejected_quantity_delta);

create index if not exists audit_events_occurred_at_read_idx
  on public.audit_events (occurred_at desc)
  include (action, entity_table, entity_id, actor_account_id);

-- Source: supabase/migrations/0101_transaction_read_indexes.sql
-- Read-path indexes for the transaction workbenches.
-- These indexes are additive and repeatable; they do not change workflow,
-- RLS, immutable-record, or posting semantics.

create index if not exists purchase_orders_open_po_no_idx
  on public.purchase_orders (po_no)
  where status in ('ORDERED', 'PARTIALLY_RECEIVED', 'REOPENED');

create index if not exists purchase_receipts_posted_receipt_no_idx
  on public.purchase_receipts (receipt_no desc)
  where status = 'POSTED';

create index if not exists hr_requests_shipped_distribution_date_idx
  on public.hr_requests (distribution_date desc)
  where status = 'SHIPPED';

create index if not exists return_notes_posted_id_idx
  on public.return_notes (id desc)
  where status = 'POSTED';

create index if not exists correction_notes_purchase_receipt_source_idx
  on public.correction_notes (original_purchase_receipt_id, id desc)
  where correction_kind = 'PURCHASE_RECEIPT';

create index if not exists correction_notes_return_note_source_idx
  on public.correction_notes (original_return_note_id, id desc)
  where correction_kind = 'RETURN';

-- Source: supabase/migrations/0102_correction_history_read_indexes.sql
-- Read-path indexes for correction history workbenches.
-- These indexes are additive and repeatable; they do not change workflow,
-- RLS, append-only, or correction posting semantics.

create index if not exists correction_notes_hr_request_source_idx
  on public.correction_notes (original_hr_request_id, id desc)
  where correction_kind = 'HR_ISSUE';

create index if not exists correction_notes_stocktake_source_idx
  on public.correction_notes (original_stocktake_id, id desc)
  where correction_kind = 'STOCKTAKE';

create index if not exists correction_notes_warehouse_shipment_source_idx
  on public.correction_notes (original_warehouse_shipment_id, id desc)
  where correction_kind = 'WAREHOUSE_TRANSFER';

create index if not exists correction_notes_replenishment_source_idx
  on public.correction_notes (original_replenishment_request_id, id desc)
  where correction_kind = 'WAREHOUSE_TRANSFER';

-- Source: supabase/migrations/0103_warehouse_shipment_queue_view.sql
-- Consolidate the warehouse queue read path without changing workflow writes.
-- The view remains security-invoker so the existing base-table RLS policies
-- decide which HR requests, replenishment requests, and draft shipments are visible.

create or replace view public.v_warehouse_shipment_queue
with (security_invoker = true)
as
select
  'HR_REQUEST:' || request_row.id::text as queue_key,
  request_row.id,
  'HR_REQUEST'::text as source,
  request_row.request_no,
  request_row.distribution_date::text as distribution_date,
  request_row.row_version,
  shipment_row.id as shipment_id,
  shipment_row.shipment_no,
  shipment_row.status as shipment_status,
  shipment_row.created_by as shipment_created_by
from public.hr_requests request_row
left join public.warehouse_shipments shipment_row
  on shipment_row.hr_request_id = request_row.id
 and shipment_row.status = 'DRAFT'
where request_row.status = 'SUBMITTED'

union all

select
  'REPLENISHMENT:' || replenishment_row.id::text as queue_key,
  replenishment_row.id,
  'REPLENISHMENT'::text as source,
  replenishment_row.request_no,
  coalesce(replenishment_row.submitted_at, replenishment_row.created_at)::text as distribution_date,
  replenishment_row.row_version,
  null::uuid as shipment_id,
  null::text as shipment_no,
  null::text as shipment_status,
  null::uuid as shipment_created_by
from public.replenishment_requests replenishment_row
where replenishment_row.status = 'SUBMITTED';

revoke all on table public.v_warehouse_shipment_queue from public, anon, authenticated;
grant select on public.v_warehouse_shipment_queue to authenticated;

-- Source: supabase/migrations/0104_hr_request_option_views.sql
-- Shape the HR request form's option reads at the database seam.
-- security_invoker keeps the existing base-table RLS policies authoritative.

create or replace view public.v_hr_request_employee_options
with (security_invoker = true)
as
select
  e.id,
  e.employee_no,
  e.name,
  e.institution_id,
  i.code as institution_code,
  i.name as institution_name,
  e.department_id,
  d.code as department_code,
  d.name as department_name
from public.employees e
join public.institutions i
  on i.id = e.institution_id
 and i.is_active
join public.departments d
  on d.id = e.department_id
 and d.institution_id = e.institution_id
 and d.is_active
where e.employment_status = 'ACTIVE';

create or replace view public.v_hr_request_item_options
with (security_invoker = true)
as
select
  availability.item_id as id,
  availability.item_code,
  availability.item_name,
  availability.size,
  availability.unit,
  availability.hr_on_hand_quantity,
  availability.general_on_hand_quantity,
  availability.active_reserved_quantity
from public.v_item_availability availability
where availability.is_active;

revoke all on table public.v_hr_request_employee_options, public.v_hr_request_item_options
from public, anon, authenticated;
grant select on public.v_hr_request_employee_options, public.v_hr_request_item_options to authenticated;

-- Source: supabase/migrations/0105_warehouse_transfer_correction_source_view.sql
-- Consolidate the completed transfer source catalog without moving workflow
-- writes or locking rules out of the existing correction RPCs.
-- security_invoker keeps the source table RLS policies authoritative.

create or replace view public.v_warehouse_transfer_correction_sources
with (security_invoker = true)
as
select
  'SHIPMENT:' || shipment_line.id::text as source_key,
  'SHIPMENT'::text as source_kind,
  shipment_line.id as line_id,
  shipment_row.id as parent_id,
  shipment_row.shipment_no as parent_no,
  shipment_line.item_code_snapshot as item_code,
  shipment_line.item_name_snapshot as item_name,
  shipment_line.actual_transfer_quantity as actual_quantity,
  shipment_line.requested_transfer_quantity_snapshot as requested_quantity
from public.warehouse_shipments shipment_row
join public.warehouse_shipment_lines shipment_line
  on shipment_line.shipment_id = shipment_row.id
where shipment_row.status = 'POSTED'
  and shipment_line.actual_transfer_quantity is not null

union all

select
  'REPLENISHMENT:' || replenishment_line.id::text as source_key,
  'REPLENISHMENT'::text as source_kind,
  replenishment_line.id as line_id,
  replenishment_row.id as parent_id,
  replenishment_row.request_no as parent_no,
  replenishment_line.item_code_snapshot as item_code,
  replenishment_line.item_name_snapshot as item_name,
  replenishment_line.actual_transfer_quantity as actual_quantity,
  replenishment_line.requested_quantity as requested_quantity
from public.replenishment_requests replenishment_row
join public.replenishment_request_lines replenishment_line
  on replenishment_line.request_id = replenishment_row.id
where replenishment_row.status = 'SHIPPED'
  and replenishment_line.actual_transfer_quantity is not null;

revoke all on table public.v_warehouse_transfer_correction_sources
from public, anon, authenticated;
grant select on public.v_warehouse_transfer_correction_sources to authenticated;

-- Source: supabase/migrations/0106_stocktake_correction_source_view.sql
-- Consolidate posted stocktake correction sources at the database read seam.
-- security_invoker preserves the existing stocktake, line, and warehouse RLS.

create or replace view public.v_stocktake_correction_sources
with (security_invoker = true)
as
select
  stocktake_line.id as line_id,
  stocktake_row.id as stocktake_id,
  stocktake_row.stocktake_no,
  stocktake_row.warehouse_id,
  warehouse_row.purpose as warehouse_purpose,
  stocktake_line.item_code_snapshot as item_code,
  stocktake_line.item_name_snapshot as item_name,
  stocktake_line.counted_quantity as counted_quantity,
  stocktake_line.book_quantity_snapshot as book_quantity
from public.stocktakes stocktake_row
join public.warehouses warehouse_row
  on warehouse_row.id = stocktake_row.warehouse_id
 and warehouse_row.is_active
join public.stocktake_lines stocktake_line
  on stocktake_line.stocktake_id = stocktake_row.id
where stocktake_row.status = 'POSTED';

revoke all on table public.v_stocktake_correction_sources
from public, anon, authenticated;
grant select on public.v_stocktake_correction_sources to authenticated;

-- Source: supabase/migrations/0107_receipt_return_correction_source_views.sql
-- Consolidate posted receipt and return correction catalogs.
-- security_invoker keeps the existing source-table RLS policies authoritative.

create or replace view public.v_purchase_receipt_correction_sources
with (security_invoker = true)
as
select
  receipt_line.id as line_id,
  receipt_row.id as receipt_id,
  receipt_row.receipt_no,
  receipt_row.purchase_order_id,
  receipt_row.received_on,
  receipt_line.item_code_snapshot as item_code,
  receipt_line.item_name_snapshot as item_name,
  receipt_line.delivered_quantity,
  receipt_line.accepted_quantity,
  receipt_line.rejected_quantity
from public.purchase_receipts receipt_row
join public.purchase_receipt_lines receipt_line
  on receipt_line.receipt_id = receipt_row.id
where receipt_row.status = 'POSTED';

create or replace view public.v_return_correction_sources
with (security_invoker = true)
as
select
  return_line.id as line_id,
  return_row.id as return_id,
  return_row.return_no,
  return_row.original_hr_request_id,
  return_row.status,
  return_line.original_issue_line_id,
  return_line.employee_no_snapshot,
  return_line.employee_name_snapshot,
  return_line.item_code_snapshot as item_code,
  return_line.item_name_snapshot as item_name,
  return_line.quantity,
  return_line.unit_snapshot
from public.return_notes return_row
join public.return_lines return_line
  on return_line.return_note_id = return_row.id
where return_row.status = 'POSTED';

revoke all on table public.v_purchase_receipt_correction_sources,
  public.v_return_correction_sources
from public, anon, authenticated;
grant select on public.v_purchase_receipt_correction_sources,
  public.v_return_correction_sources to authenticated;

-- Source: supabase/migrations/0108_hr_issue_correction_source_view.sql
-- Consolidate shipped HR issue correction sources.
-- security_invoker keeps the existing HR request and issue-line RLS policies.

create or replace view public.v_hr_issue_correction_sources
with (security_invoker = true)
as
select
  issue_line.id as line_id,
  request_row.id as request_id,
  request_row.request_no,
  request_row.status,
  request_row.distribution_date,
  issue_line.line_no,
  issue_line.employee_no_snapshot,
  issue_line.employee_name_snapshot,
  issue_line.item_code_snapshot as item_code,
  issue_line.item_name_snapshot as item_name,
  issue_line.quantity
from public.hr_requests request_row
join public.hr_issue_lines issue_line
  on issue_line.request_id = request_row.id
where request_row.status = 'SHIPPED';

revoke all on table public.v_hr_issue_correction_sources
from public, anon, authenticated;
grant select on public.v_hr_issue_correction_sources to authenticated;

-- Source: supabase/migrations/0109_seasonal_procurement_queue_view.sql
-- Shape the approved seasonal procurement queue at the database read seam.
-- security_invoker preserves approval and procurement-line RLS policies.

create or replace view public.v_seasonal_procurement_queue
with (security_invoker = true)
as
select
  approval_line.id as approval_line_id,
  approval_line.item_id,
  approval_line.item_code_snapshot,
  approval_line.item_name_snapshot,
  approval_line.size_snapshot,
  approval_line.unit_snapshot,
  approval_line.approved_quantity,
  procurement_line.id as procurement_id,
  procurement_line.supplier_id as procurement_supplier_id,
  procurement_line.final_purchase_quantity,
  procurement_line.minimum_order_quantity_snapshot
from public.seasonal_approval_lines approval_line
join public.seasonal_approvals approval
  on approval.id = approval_line.approval_id
 and approval.status = 'APPROVED'
left join public.seasonal_procurement_lines procurement_line
  on procurement_line.approval_line_id = approval_line.id;

revoke all on table public.v_seasonal_procurement_queue
from public, anon, authenticated;
grant select on public.v_seasonal_procurement_queue to authenticated;

-- Source: supabase/migrations/0110_seasonal_demand_workspace_view.sql
-- Consolidate seasonal demand scope and registered lines into one read seam.
-- Tagged UNION ALL avoids the employee x item row explosion of a joined scope view.
-- security_invoker keeps the base-table RLS policies authoritative.
create or replace view public.v_seasonal_demand_workspace
with (security_invoker = true)
as
select
  'EMPLOYEE'::text as scope_kind,
  scope_employee.campaign_id,
  scope_employee.employee_id,
  scope_employee.employee_no_snapshot,
  scope_employee.employee_name_snapshot,
  null::uuid as item_id,
  null::text as item_code_snapshot,
  null::text as item_name_snapshot,
  null::text as size_snapshot,
  null::text as unit_snapshot,
  null::uuid as demand_line_id,
  null::text as demand_employee_no_snapshot,
  null::text as demand_employee_name_snapshot,
  null::text as demand_item_code_snapshot,
  null::text as demand_item_name_snapshot,
  null::text as demand_size_snapshot,
  null::bigint as demand_quantity,
  null::boolean as demand_hr_modified,
  null::text as demand_hr_note,
  null::timestamptz as demand_updated_at
from public.seasonal_campaign_employees scope_employee

union all

select
  'ITEM'::text as scope_kind,
  scope_item.campaign_id,
  null::uuid as employee_id,
  null::text as employee_no_snapshot,
  null::text as employee_name_snapshot,
  scope_item.item_id,
  scope_item.item_code_snapshot,
  scope_item.item_name_snapshot,
  scope_item.size_snapshot,
  scope_item.unit_snapshot,
  null::uuid as demand_line_id,
  null::text as demand_employee_no_snapshot,
  null::text as demand_employee_name_snapshot,
  null::text as demand_item_code_snapshot,
  null::text as demand_item_name_snapshot,
  null::text as demand_size_snapshot,
  null::bigint as demand_quantity,
  null::boolean as demand_hr_modified,
  null::text as demand_hr_note,
  null::timestamptz as demand_updated_at
from public.seasonal_campaign_items scope_item

union all

select
  'DEMAND'::text as scope_kind,
  demand_line.campaign_id,
  demand_line.employee_id,
  null::text as employee_no_snapshot,
  null::text as employee_name_snapshot,
  demand_line.item_id,
  null::text as item_code_snapshot,
  null::text as item_name_snapshot,
  null::text as size_snapshot,
  null::text as unit_snapshot,
  demand_line.id as demand_line_id,
  demand_line.employee_no_snapshot as demand_employee_no_snapshot,
  demand_line.employee_name_snapshot as demand_employee_name_snapshot,
  demand_line.item_code_snapshot as demand_item_code_snapshot,
  demand_line.item_name_snapshot as demand_item_name_snapshot,
  demand_line.size_snapshot as demand_size_snapshot,
  demand_line.quantity as demand_quantity,
  demand_line.hr_modified as demand_hr_modified,
  demand_line.hr_note as demand_hr_note,
  demand_line.updated_at as demand_updated_at
from public.seasonal_demand_lines demand_line;

revoke all on table public.v_seasonal_demand_workspace from public, anon, authenticated;
grant select on public.v_seasonal_demand_workspace to authenticated;

-- Source: supabase/migrations/0111_seasonal_approval_queue_view.sql
-- Consolidate pending seasonal approval submissions with their campaign label.
-- security_invoker preserves the approval and campaign RLS policies.
create or replace view public.v_seasonal_approval_queue
with (security_invoker = true)
as
select
  submission.id as submission_id,
  submission.campaign_id,
  submission.revision,
  submission.demand_snapshot_hash,
  submission.submitted_at,
  campaign.campaign_no,
  campaign.name as campaign_name
from public.seasonal_approval_submissions submission
join public.seasonal_campaigns campaign
  on campaign.id = submission.campaign_id
where submission.status = 'PENDING';

revoke all on table public.v_seasonal_approval_queue from public, anon, authenticated;
grant select on public.v_seasonal_approval_queue to authenticated;

-- Source: supabase/migrations/0112_hr_request_history_detail_view.sql
-- Consolidate selected HR request detail rows without multiplying item/issue/reservation data.
-- security_invoker keeps the underlying table RLS policies authoritative.
create or replace view public.v_hr_request_history_detail
with (security_invoker = true)
as
select
  request_item.request_id,
  'ITEM'::text as detail_kind,
  request_item.id as detail_id,
  request_item.item_id,
  request_item.item_code_snapshot,
  request_item.item_name_snapshot,
  request_item.unit_snapshot,
  request_item.issue_quantity,
  request_item.increase_quantity,
  request_item.requested_transfer_quantity,
  null::integer as line_no,
  null::text as employee_no_snapshot,
  null::text as employee_name_snapshot,
  null::text as institution_code_snapshot,
  null::text as department_code_snapshot,
  null::text as size_snapshot,
  null::bigint as quantity,
  null::text as reservation_status,
  null::timestamptz as closed_at
from public.hr_request_items request_item

union all

select
  issue_line.request_id,
  'ISSUE'::text as detail_kind,
  issue_line.id as detail_id,
  issue_line.item_id,
  issue_line.item_code_snapshot,
  issue_line.item_name_snapshot,
  issue_line.unit_snapshot,
  null::bigint as issue_quantity,
  null::bigint as increase_quantity,
  null::bigint as requested_transfer_quantity,
  issue_line.line_no,
  issue_line.employee_no_snapshot,
  issue_line.employee_name_snapshot,
  issue_line.institution_code_snapshot,
  issue_line.department_code_snapshot,
  issue_line.size_snapshot,
  issue_line.quantity,
  null::text as reservation_status,
  null::timestamptz as closed_at
from public.hr_issue_lines issue_line

union all

select
  reservation.source_hr_request_id as request_id,
  'RESERVATION'::text as detail_kind,
  reservation.id as detail_id,
  reservation.item_id,
  null::text as item_code_snapshot,
  null::text as item_name_snapshot,
  null::text as unit_snapshot,
  null::bigint as issue_quantity,
  null::bigint as increase_quantity,
  null::bigint as requested_transfer_quantity,
  null::integer as line_no,
  null::text as employee_no_snapshot,
  null::text as employee_name_snapshot,
  null::text as institution_code_snapshot,
  null::text as department_code_snapshot,
  null::text as size_snapshot,
  reservation.quantity,
  reservation.status as reservation_status,
  reservation.closed_at
from public.inventory_reservations reservation;

revoke all on table public.v_hr_request_history_detail from public, anon, authenticated;
grant select on public.v_hr_request_history_detail to authenticated;

-- Source: supabase/migrations/0113_stocktake_server_recapture.sql
-- Server-side recapture keeps the current balance snapshot and the recount
-- confirmation in one database round trip. The existing update RPC remains
-- the single write authority and keeps its item/version fencing.

create or replace function public.recapture_stocktake_draft(
  p_stocktake_id uuid,
  p_note text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  stocktake_row public.stocktakes;
  line_ids uuid[];
  recount_lines jsonb;
  updated_stocktake public.stocktakes;
  result_lines jsonb;
begin
  current_account := private.current_account_id();
  if auth.uid() is null
     or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null
     or (not private.has_role('HR') and not private.has_role('WAREHOUSE')) then
    raise exception using errcode = '42501', message = 'HR or WAREHOUSE role is required';
  end if;

  if p_stocktake_id is null
     or btrim(coalesce(p_idempotency_key, '')) = ''
     or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'Stocktake recapture fields are invalid';
  end if;

  select * into stocktake_row
  from public.stocktakes
  where id = p_stocktake_id and created_by = current_account;
  if stocktake_row.id is null then
    raise exception 'Stocktake draft does not exist';
  end if;

  -- Check the write authority's command first so an uncertain response can
  -- safely replay the already-succeeded result after the draft is DRAFT again.
  select * into command_row
  from public.operation_commands
  where operation_code = 'UPDATE_STOCKTAKE_DRAFT'
    and idempotency_key = p_idempotency_key
  for update;
  if command_row.id is not null then
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' and command_row.result_entity_id is not null then
      select * into updated_stocktake
      from public.stocktakes
      where id = command_row.result_entity_id;
      if updated_stocktake.id is null then
        raise exception 'Stocktake recapture result does not exist';
      end if;
    else
      raise exception using errcode = '40001', message = 'Stocktake recapture is already in progress or failed';
    end if;
  else
    if stocktake_row.status <> 'STALE_COUNT' then
      raise exception 'Only STALE_COUNT stocktakes can be recaptured';
    end if;

    select coalesce(array_agg(item_id order by item_id), '{}'::uuid[])
      into line_ids
    from public.stocktake_lines
    where stocktake_id = p_stocktake_id;
    if coalesce(array_length(line_ids, 1), 0) = 0 then
      raise exception 'A stocktake must contain at least one line';
    end if;

    insert into public.inventory_balances (warehouse_id, item_id)
    select stocktake_row.warehouse_id, item_id
    from unnest(line_ids) as requested(item_id)
    on conflict (warehouse_id, item_id) do nothing;

    -- The update RPC uses the same item-mutex -> stocktake lock order and
    -- re-reads the balances after locking. This preliminary lock prevents the
    -- server-side snapshot from being assembled across a concurrent inventory
    -- mutation while keeping the existing write authority unchanged.
    perform 1
  from public.inventory_balances balance_row
  where balance_row.warehouse_id = stocktake_row.warehouse_id
    and balance_row.item_id = any(line_ids)
  order by balance_row.item_id
  for update;

    select jsonb_agg(
      jsonb_build_object(
        'itemId', line_row.item_id,
        'countedQuantity', balance_row.on_hand_quantity,
        'reason', ''
      ) order by line_row.item_id
    ) into recount_lines
    from public.stocktake_lines line_row
    join public.inventory_balances balance_row
      on balance_row.warehouse_id = stocktake_row.warehouse_id
     and balance_row.item_id = line_row.item_id
    where line_row.stocktake_id = p_stocktake_id;

    updated_stocktake := public.update_stocktake_draft(
      p_stocktake_id,
      concat('RECOUNT_CONFIRMED:', btrim(coalesce(p_note, ''))),
      recount_lines,
      true,
      p_idempotency_key,
      p_request_fingerprint
    );
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', line_row.id,
      'item_id', line_row.item_id,
      'book_quantity_snapshot', line_row.book_quantity_snapshot,
      'balance_version_snapshot', line_row.balance_version_snapshot,
      'counted_quantity', line_row.counted_quantity,
      'reason', coalesce(line_row.reason, '')
    ) order by line_row.item_id
  ), '[]'::jsonb)
    into result_lines
  from public.stocktake_lines line_row
  where line_row.stocktake_id = p_stocktake_id;

  return jsonb_build_object(
    'stocktake', to_jsonb(updated_stocktake),
    'lines', result_lines
  );
end;
$$;

revoke all on function public.recapture_stocktake_draft(uuid, text, text, text) from public, anon;
grant execute on function public.recapture_stocktake_draft(uuid, text, text, text) to authenticated;

-- Source: supabase/migrations/0114_warehouse_post_with_lines.sql
-- Keep HR shipment line edits and posting in one server-side transaction.
-- The existing post_warehouse_shipment RPC remains the posting authority;
-- this wrapper only validates and applies the draft line payload before it
-- delegates to that authority.

create or replace function public.post_warehouse_shipment_with_lines(
  p_shipment_id uuid,
  p_lines jsonb,
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
  posted_row public.warehouse_shipments;
  line_value jsonb;
  line_count integer;
  updated_count integer;
  line_id uuid;
  inner_idempotency_key text;
  inner_request_fingerprint text;
begin
  current_account := private.current_account_id();
  if auth.uid() is null
     or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null
     or not private.has_role('WAREHOUSE') then
    raise exception using errcode = '42501', message = 'WAREHOUSE role is required';
  end if;

  if p_shipment_id is null
     or btrim(coalesce(p_idempotency_key, '')) = ''
     or btrim(coalesce(p_request_fingerprint, '')) = ''
     or p_lines is null
     or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'Shipment post fields are invalid';
  end if;
  line_count := jsonb_array_length(p_lines);
  if line_count = 0 or line_count > 1000 or pg_column_size(p_lines) > 10000000 then
    raise exception 'Shipment line limits exceeded';
  end if;

  for line_value in select value from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(line_value) <> 'object'
       or coalesce(line_value ->> 'lineId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or coalesce(line_value ->> 'actualTransferQuantity', '') !~ '^[0-9][0-9]{0,17}$'
       or length(coalesce(line_value ->> 'shortShipReasonCode', '')) > 100 then
      raise exception 'Invalid shipment line';
    end if;
  end loop;
  if exists (
    select 1
    from (
      select (value ->> 'lineId')::uuid as line_id
      from jsonb_array_elements(p_lines)
    ) requested
    group by line_id
    having count(*) > 1
  ) then
    raise exception 'A shipment cannot contain the same line more than once';
  end if;
  if line_count <> (
    select count(*)
    from public.warehouse_shipment_lines shipment_line
    where shipment_line.shipment_id = p_shipment_id
  )
  or exists (
    select 1
    from public.warehouse_shipment_lines shipment_line
    where shipment_line.shipment_id = p_shipment_id
      and not exists (
        select 1
        from jsonb_array_elements(p_lines) payload
        where (payload ->> 'lineId')::uuid = shipment_line.id
      )
  ) then
    raise exception 'Shipment lines changed; reload the draft and retry';
  end if;

  insert into public.operation_commands (
    operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id
  ) values (
    'POST_WAREHOUSE_SHIPMENT_WITH_LINES', p_idempotency_key, p_request_fingerprint, current_account
  ) on conflict (operation_code, idempotency_key) do nothing
  returning * into command_row;

  if command_row.id is null then
    select * into command_row
    from public.operation_commands
    where operation_code = 'POST_WAREHOUSE_SHIPMENT_WITH_LINES'
      and idempotency_key = p_idempotency_key
    for update;
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED'
       and command_row.result_entity_id = p_shipment_id then
      select * into posted_row
      from public.warehouse_shipments
      where id = p_shipment_id;
      return posted_row;
    end if;
    raise exception using errcode = '40001', message = 'shipment is already in progress or failed';
  end if;

  for line_value in select value from jsonb_array_elements(p_lines) loop
    line_id := (line_value ->> 'lineId')::uuid;
    update public.warehouse_shipment_lines shipment_line
    set actual_transfer_quantity = (line_value ->> 'actualTransferQuantity')::bigint,
        short_ship_reason_code = nullif(btrim(line_value ->> 'shortShipReasonCode'), '')
    where shipment_line.id = line_id
      and shipment_line.shipment_id = p_shipment_id;
    get diagnostics updated_count = row_count;
    if updated_count <> 1 then
      raise exception 'Shipment line does not belong to the shipment';
    end if;
  end loop;

  inner_idempotency_key := concat('WITH-LINES:', p_idempotency_key);
  inner_request_fingerprint := concat('WITH-LINES:', p_request_fingerprint);
  posted_row := public.post_warehouse_shipment(
    p_shipment_id,
    inner_idempotency_key,
    inner_request_fingerprint
  );

  update public.operation_commands
  set status = 'SUCCEEDED',
      result_entity_type = 'warehouse_shipments',
      result_entity_id = p_shipment_id,
      succeeded_at = now()
  where id = command_row.id;

  return posted_row;
end;
$$;

revoke all on function public.post_warehouse_shipment_with_lines(uuid, jsonb, text, text) from public, anon;
grant execute on function public.post_warehouse_shipment_with_lines(uuid, jsonb, text, text) to authenticated;

-- Source: supabase/migrations/0115_sso_account_email_read_index.sql
-- The SSO adapter resolves central email identities against the local account
-- table. Keep this lookup indexed after the Auth user scan was removed from
-- the login hot path; this migration does not change data or authorization.

create index if not exists app_accounts_email_snapshot_idx
  on public.app_accounts (email_snapshot)
  where email_snapshot is not null;

-- Source: supabase/migrations/0116_correction_history_view.sql
-- Consolidate correction history reads for the correction workbenches.
-- The view is security-invoker so source-table RLS remains authoritative.

create or replace view public.v_correction_history
with (security_invoker = true)
as
select
  note.id as correction_id,
  note.correction_kind,
  'PURCHASE_RECEIPT'::text as source_kind,
  note.correction_no,
  note.status,
  note.reason,
  note.posted_at,
  note.original_purchase_receipt_id as source_parent_id,
  line.original_receipt_line_id as source_line_id,
  null::bigint as delta_quantity,
  line.delivered_quantity_delta,
  line.accepted_quantity_delta,
  line.rejected_quantity_delta
from public.correction_notes note
join public.purchase_receipt_correction_lines line
  on line.correction_note_id = note.id
where note.correction_kind = 'PURCHASE_RECEIPT'

union all

select
  note.id as correction_id,
  note.correction_kind,
  'RETURN'::text as source_kind,
  note.correction_no,
  note.status,
  note.reason,
  note.posted_at,
  note.original_return_note_id as source_parent_id,
  line.original_return_line_id as source_line_id,
  line.return_quantity_delta as delta_quantity,
  null::bigint as delivered_quantity_delta,
  null::bigint as accepted_quantity_delta,
  null::bigint as rejected_quantity_delta
from public.correction_notes note
join public.return_correction_lines line
  on line.correction_note_id = note.id
where note.correction_kind = 'RETURN'

union all

select
  note.id as correction_id,
  note.correction_kind,
  'HR_ISSUE'::text as source_kind,
  note.correction_no,
  note.status,
  note.reason,
  note.posted_at,
  note.original_hr_request_id as source_parent_id,
  line.original_issue_line_id as source_line_id,
  line.issue_quantity_delta as delta_quantity,
  null::bigint as delivered_quantity_delta,
  null::bigint as accepted_quantity_delta,
  null::bigint as rejected_quantity_delta
from public.correction_notes note
join public.issue_correction_lines line
  on line.correction_note_id = note.id
where note.correction_kind = 'HR_ISSUE'

union all

select
  note.id as correction_id,
  note.correction_kind,
  'SHIPMENT'::text as source_kind,
  note.correction_no,
  note.status,
  note.reason,
  note.posted_at,
  note.original_warehouse_shipment_id as source_parent_id,
  line.original_shipment_line_id as source_line_id,
  line.transfer_quantity_delta as delta_quantity,
  null::bigint as delivered_quantity_delta,
  null::bigint as accepted_quantity_delta,
  null::bigint as rejected_quantity_delta
from public.correction_notes note
join public.warehouse_transfer_correction_lines line
  on line.correction_note_id = note.id
where note.correction_kind = 'WAREHOUSE_TRANSFER'
  and note.original_warehouse_shipment_id is not null

union all

select
  note.id as correction_id,
  note.correction_kind,
  'REPLENISHMENT'::text as source_kind,
  note.correction_no,
  note.status,
  note.reason,
  note.posted_at,
  note.original_replenishment_request_id as source_parent_id,
  line.original_replenishment_line_id as source_line_id,
  line.transfer_quantity_delta as delta_quantity,
  null::bigint as delivered_quantity_delta,
  null::bigint as accepted_quantity_delta,
  null::bigint as rejected_quantity_delta
from public.correction_notes note
join public.warehouse_transfer_correction_lines line
  on line.correction_note_id = note.id
where note.correction_kind = 'WAREHOUSE_TRANSFER'
  and note.original_replenishment_request_id is not null

union all

select
  note.id as correction_id,
  note.correction_kind,
  'STOCKTAKE'::text as source_kind,
  note.correction_no,
  note.status,
  note.reason,
  note.posted_at,
  note.original_stocktake_id as source_parent_id,
  line.original_stocktake_line_id as source_line_id,
  line.counted_quantity_delta as delta_quantity,
  null::bigint as delivered_quantity_delta,
  null::bigint as accepted_quantity_delta,
  null::bigint as rejected_quantity_delta
from public.correction_notes note
join public.stocktake_correction_lines line
  on line.correction_note_id = note.id
where note.correction_kind = 'STOCKTAKE';

revoke all on table public.v_correction_history from public, anon, authenticated;
grant select on public.v_correction_history to authenticated;

-- Source: supabase/migrations/0117_replenishment_shipment_lines_view.sql
-- Shape submitted replenishment line reads at the database seam.
-- The view keeps the existing RLS policies authoritative and lets the
-- warehouse workbench read line snapshots plus current GENERAL availability
-- in one round trip. Posting still rechecks stock and locks in its RPC.

create index if not exists replenishment_request_lines_request_item_read_idx
  on public.replenishment_request_lines (request_id, item_id);

create or replace view public.v_replenishment_shipment_lines
with (security_invoker = true)
as
select
  line.id,
  line.request_id,
  line.item_id,
  line.requested_quantity,
  line.item_code_snapshot,
  line.item_name_snapshot,
  line.unit_snapshot,
  line.maximum_transfer_quantity_snapshot,
  line.actual_transfer_quantity,
  line.short_ship_reason_code,
  coalesce(availability.general_on_hand_quantity, 0)::bigint as general_on_hand_quantity,
  case
    when line.maximum_transfer_quantity_snapshot is null
      then least(line.requested_quantity, coalesce(availability.general_on_hand_quantity, 0)::bigint)
    else line.maximum_transfer_quantity_snapshot
  end::bigint as effective_maximum_transfer_quantity
from public.replenishment_request_lines line
join public.replenishment_requests request_row
  on request_row.id = line.request_id
 and request_row.status = 'SUBMITTED'
left join public.v_item_availability availability
  on availability.item_id = line.item_id;

revoke all on table public.v_replenishment_shipment_lines from public, anon, authenticated;
grant select on public.v_replenishment_shipment_lines to authenticated;

-- Source: supabase/migrations/0118_overview_core_view.sql
-- Shape the actionable overview summaries into one read response.
-- Activity and audit history intentionally remain deferred browser reads.
-- This view is read-only; all workflow and inventory authority stays in the
-- existing protected RPCs and append-only source tables.

create or replace view public.v_overview_core
with (security_invoker = true)
as
select
  'current'::text as snapshot_key,
  coalesce((
    select jsonb_agg(to_jsonb(source_row) order by source_row.item_code)
    from (
      select item_code, item_name, available_to_request_quantity,
        combined_on_hand_quantity, active_reserved_quantity
      from public.v_item_availability
      order by item_code
      limit 300
    ) source_row
  ), '[]'::jsonb) as availability,
  coalesce((
    select jsonb_agg(to_jsonb(source_row) order by source_row.created_at desc)
    from (
      select request_id, request_no, status, distribution_date, created_at,
        requested_transfer_quantity
      from public.v_hr_request_item_totals
      order by created_at desc
      limit 300
    ) source_row
  ), '[]'::jsonb) as hr_requests,
  coalesce((
    select jsonb_agg(to_jsonb(source_row) order by source_row.distribution_date)
    from (
      select shipment_id, shipment_no, request_no, distribution_date,
        needs_warehouse_attention
      from public.v_pending_warehouse_shipments
      order by distribution_date
      limit 300
    ) source_row
  ), '[]'::jsonb) as shipments,
  coalesce((
    select jsonb_agg(to_jsonb(source_row) order by source_row.remaining_to_accept desc)
    from (
      select purchase_order_id, po_no, ordered_quantity, accepted_to_date,
        remaining_to_accept
      from public.v_purchase_order_receipt_progress
      order by remaining_to_accept desc
      limit 300
    ) source_row
  ), '[]'::jsonb) as receipts;

revoke all on table public.v_overview_core from public, anon, authenticated;
grant select on public.v_overview_core to authenticated;

-- Source: supabase/migrations/0119_warehouse_shipment_lines_view.sql
-- Shape HR warehouse shipment draft lines and request snapshots in one read.
-- Posting remains owned by post_warehouse_shipment(_with_lines) and still
-- revalidates every quantity, source version, role and inventory lock.

create index if not exists warehouse_shipment_lines_shipment_item_read_idx
  on public.warehouse_shipment_lines (shipment_id, item_id);

create or replace view public.v_warehouse_shipment_lines
with (security_invoker = true)
as
select
  shipment_line.id,
  shipment_line.shipment_id,
  shipment_line.item_id,
  shipment_line.hr_request_item_id,
  request_item.item_code_snapshot,
  request_item.item_name_snapshot,
  request_item.unit_snapshot,
  shipment_line.requested_transfer_quantity_snapshot,
  shipment_line.maximum_transfer_quantity_snapshot,
  shipment_line.actual_transfer_quantity,
  shipment_line.short_ship_reason_code
from public.warehouse_shipment_lines shipment_line
left join public.hr_request_items request_item
  on request_item.id = shipment_line.hr_request_item_id;

revoke all on table public.v_warehouse_shipment_lines from public, anon, authenticated;
grant select on public.v_warehouse_shipment_lines to authenticated;

-- Source: supabase/migrations/0120_employee_directory_view.sql
-- Shape the employee directory with organization snapshots into one read.
-- security_invoker keeps the existing employees/institutions/departments RLS
-- policies authoritative, including visibility of inactive historical rows.

create or replace view public.v_employee_directory
with (security_invoker = true)
as
select
  employee.id,
  employee.employee_no,
  employee.name,
  employee.institution_id,
  institution.code as institution_code,
  institution.name as institution_name,
  employee.department_id,
  department.code as department_code,
  department.name as department_name,
  employee.employment_status,
  employee.job_title,
  employee.hire_date,
  employee.termination_date,
  employee.note
from public.employees employee
left join public.institutions institution
  on institution.id = employee.institution_id
left join public.departments department
  on department.id = employee.department_id
 and department.institution_id = employee.institution_id;

revoke all on table public.v_employee_directory from public, anon, authenticated;
grant select on public.v_employee_directory to authenticated;

-- Source: supabase/migrations/0121_account_directory_view.sql
-- Shape the SYSTEM_ADMIN account directory and stored roles into one read.
-- security_invoker keeps app_accounts and user_roles RLS authoritative.

create or replace view public.v_account_directory
with (security_invoker = true)
as
select
  account.id,
  account.auth_user_id,
  account.login_name,
  account.display_name,
  account.email_snapshot,
  account.is_active,
  coalesce(
    jsonb_agg(to_jsonb(account_role.role_code) order by account_role.role_code)
      filter (where account_role.role_code is not null),
    '[]'::jsonb
  ) as role_codes
from public.app_accounts account
left join public.user_roles account_role
  on account_role.account_id = account.id
group by
  account.id,
  account.auth_user_id,
  account.login_name,
  account.display_name,
  account.email_snapshot,
  account.is_active;

revoke all on table public.v_account_directory from public, anon, authenticated;
grant select on public.v_account_directory to authenticated;

-- Source: supabase/migrations/0122_remove_redundant_master_conflict_indexes.sql
-- 0083 created temporary-style unique indexes so PostgreSQL could infer the
-- original ON CONFLICT targets.  After 0084, the RPC uses named constraints;
-- keep only the constraint-backed indexes to reduce write and vacuum cost.
-- Fail closed if the target project is not already on the named-constraint
-- contract.  This migration must never be used to hide a 42P10 problem.
do $migration$
declare
  missing_constraints text;
  current_definition text;
  constraint_row record;
begin
  select string_agg(expected.constraint_name, ', ' order by expected.constraint_name)
  into missing_constraints
  from (
    values
      ('operation_commands'::text, 'operation_commands_operation_code_idempotency_key_key'::text),
      ('institutions'::text, 'institutions_code_key'::text),
      ('departments'::text, 'departments_institution_id_code_key'::text),
      ('uniform_items'::text, 'uniform_items_item_code_key'::text),
      ('suppliers'::text, 'suppliers_supplier_code_key'::text),
      ('supplier_uniform_items'::text, 'supplier_uniform_items_pkey'::text)
  ) as expected(table_name, constraint_name)
  where not exists (
    select 1
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = expected.table_name
      and c.conname = expected.constraint_name
      and c.contype in ('p', 'u')
  );

  if missing_constraints is not null then
    raise exception using
      errcode = '55000',
      message = '0122 requires named master-data constraints: ' || missing_constraints;
  end if;

  select pg_get_functiondef(
    'public.apply_master_import(text,text,jsonb,text,text)'::regprocedure
  )
  into current_definition;

  if current_definition is null then
    raise exception using
      errcode = '42883',
      message = '0122 requires public.apply_master_import(text,text,jsonb,text,text)';
  end if;

  for constraint_row in
    select constraint_name
    from (
      values
        ('operation_commands_operation_code_idempotency_key_key'::text),
        ('institutions_code_key'::text),
        ('departments_institution_id_code_key'::text),
        ('uniform_items_item_code_key'::text),
        ('suppliers_supplier_code_key'::text),
        ('supplier_uniform_items_pkey'::text)
    ) as required(constraint_name)
  loop
    if position(
      lower('on conflict on constraint ' || constraint_row.constraint_name)
      in lower(current_definition)
    ) = 0 then
      raise exception using
        errcode = '55000',
        message = '0122 requires apply_master_import to use named constraint ' || constraint_row.constraint_name;
    end if;
  end loop;
end;
$migration$;

drop index if exists public.operation_commands_operation_idempotency_conflict_idx;
drop index if exists public.institutions_code_conflict_idx;
drop index if exists public.departments_institution_code_conflict_idx;
drop index if exists public.uniform_items_item_code_conflict_idx;
drop index if exists public.suppliers_supplier_code_conflict_idx;
drop index if exists public.supplier_uniform_items_supplier_item_conflict_idx;

-- Source: supabase/migrations/0123_correction_history_line_indexes.sql
-- Read-path indexes for the unified correction history view.
-- The browser filters v_correction_history by source_line_id and joins the
-- source line back to correction_note_id. These indexes are additive and
-- repeatable; they do not change workflow, RLS, append-only, or posting rules.
-- purchase_receipt_correction_lines already has the equivalent index in 0100.

create index if not exists return_correction_lines_source_read_idx
  on public.return_correction_lines (original_return_line_id, correction_note_id);

create index if not exists issue_correction_lines_source_read_idx
  on public.issue_correction_lines (original_issue_line_id, correction_note_id);

create index if not exists warehouse_transfer_correction_lines_shipment_source_read_idx
  on public.warehouse_transfer_correction_lines (original_shipment_line_id, correction_note_id)
  where original_shipment_line_id is not null;

create index if not exists warehouse_transfer_correction_lines_replenishment_source_read_idx
  on public.warehouse_transfer_correction_lines (original_replenishment_line_id, correction_note_id)
  where original_replenishment_line_id is not null;

create index if not exists stocktake_correction_lines_source_read_idx
  on public.stocktake_correction_lines (original_stocktake_line_id, correction_note_id);

-- Source: supabase/migrations/0124_durable_import_work_queue_index.sql
-- Read-path index for the durable import worker queue.
-- list_import_work() filters to non-terminal batches and returns the oldest
-- work first. Keep terminal rows out of the index so normal retention history
-- does not increase the worker's queue scan or write cost.

create index if not exists import_batches_work_queue_idx
  on public.import_batches (created_at, id)
  where status in (
    'AWAITING_UPLOAD', 'UPLOADED', 'PARSING',
    'VALIDATING', 'VALIDATED', 'APPLYING'
  );

-- Source: supabase/migrations/0125_atomic_seasonal_campaign_setup.sql
-- Keep the single-request setup compatible with the existing audited,
-- idempotent operations. A missing prerequisite means this migration must not
-- install a wrapper with a different underlying contract.
do $migration$
begin
  if to_regprocedure(
    'public.create_seasonal_campaign(text,text,text,date,date,timestamptz,timestamptz,text,text)'
  ) is null then
    raise exception using
      errcode = '42883',
      message = '0125 requires public.create_seasonal_campaign(text,text,text,date,date,timestamptz,timestamptz,text,text)';
  end if;

  if to_regprocedure(
    'public.set_seasonal_campaign_scope(uuid,uuid[],uuid[],text,text)'
  ) is null then
    raise exception using
      errcode = '42883',
      message = '0125 requires public.set_seasonal_campaign_scope(uuid,uuid[],uuid[],text,text)';
  end if;
end;
$migration$;

-- PostgREST invokes this function in one transaction. If campaign creation or
-- scope validation fails, both existing RPCs roll back together; successful
-- calls preserve their independent operation-command idempotency records.
create or replace function public.create_seasonal_campaign_with_scope(
  p_campaign_no text,
  p_name text,
  p_season text,
  p_window_start date,
  p_window_end date,
  p_opens_at timestamptz,
  p_closes_at timestamptz,
  p_employee_ids uuid[],
  p_item_ids uuid[],
  p_create_idempotency_key text,
  p_create_request_fingerprint text,
  p_scope_idempotency_key text,
  p_scope_request_fingerprint text
)
returns public.seasonal_campaigns
language plpgsql
security definer
set search_path = pg_catalog, private
as $function$
declare
  campaign_row public.seasonal_campaigns;
begin
  campaign_row := public.create_seasonal_campaign(
    p_campaign_no,
    p_name,
    p_season,
    p_window_start,
    p_window_end,
    p_opens_at,
    p_closes_at,
    p_create_idempotency_key,
    p_create_request_fingerprint
  );

  campaign_row := public.set_seasonal_campaign_scope(
    campaign_row.id,
    p_employee_ids,
    p_item_ids,
    p_scope_idempotency_key,
    p_scope_request_fingerprint
  );

  return campaign_row;
end;
$function$;

revoke all on function public.create_seasonal_campaign_with_scope(
  text,text,text,date,date,timestamptz,timestamptz,uuid[],uuid[],text,text,text,text
) from public, anon;
grant execute on function public.create_seasonal_campaign_with_scope(
  text,text,text,date,date,timestamptz,timestamptz,uuid[],uuid[],text,text,text,text
) to authenticated;

-- Source: supabase/migrations/0126_atomic_purchase_receipt_completion.sql
-- Complete the common one-step receipt path in one database transaction and
-- one browser round trip, reusing the existing guarded/idempotent operations.
create or replace function public.complete_purchase_receipt(
  p_receipt_no text,
  p_purchase_order_line_id uuid,
  p_delivered_quantity bigint,
  p_accepted_quantity bigint,
  p_rejected_quantity bigint,
  p_rejection_reason text,
  p_received_on date,
  p_create_idempotency_key text,
  p_create_request_fingerprint text,
  p_post_idempotency_key text,
  p_post_request_fingerprint text
)
returns public.purchase_receipts
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  locked_item_id uuid;
  draft_receipt public.purchase_receipts;
  completed_receipt public.purchase_receipts;
begin
  current_account := private.current_account_id();
  if auth.uid() is null
     or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null
     or not private.has_role('WAREHOUSE') then
    raise exception using errcode = '42501', message = 'WAREHOUSE role is required';
  end if;

  -- Match the POST RPC's item-before-purchase-order lock order. The explicit
  -- role check above protects the SECURITY DEFINER lock-table access.
  select pol.item_id into locked_item_id
  from public.purchase_order_lines pol
  where pol.id = p_purchase_order_line_id;
  if locked_item_id is null then
    raise exception 'Purchase order line does not exist';
  end if;
  insert into public.inventory_item_locks (item_id)
  values (locked_item_id)
  on conflict (item_id) do nothing;
  perform 1 from public.inventory_item_locks
  where item_id = locked_item_id
  for update;

  draft_receipt := public.create_purchase_receipt_draft(
    p_receipt_no,
    p_purchase_order_line_id,
    p_delivered_quantity,
    p_accepted_quantity,
    p_rejected_quantity,
    p_rejection_reason,
    p_received_on,
    p_create_idempotency_key,
    p_create_request_fingerprint
  );

  completed_receipt := public.post_purchase_receipt(
    draft_receipt.id,
    p_post_idempotency_key,
    p_post_request_fingerprint
  );

  return completed_receipt;
end;
$$;

revoke all on function public.complete_purchase_receipt(text, uuid, bigint, bigint, bigint, text, date, text, text, text, text)
  from public, anon;
grant execute on function public.complete_purchase_receipt(text, uuid, bigint, bigint, bigint, text, date, text, text, text, text)
  to authenticated;

-- Source: supabase/migrations/0127_atomic_stocktake_completion.sql
-- Complete the common stocktake path in one transaction while reusing the
-- existing snapshot, role, idempotency, reservation, and posting rules.
create or replace function public.complete_stocktake(
  p_stocktake_id uuid,
  p_stocktake_no text,
  p_warehouse_id uuid,
  p_note text,
  p_lines jsonb,
  p_create_idempotency_key text,
  p_create_request_fingerprint text,
  p_update_idempotency_key text,
  p_update_request_fingerprint text,
  p_post_idempotency_key text,
  p_post_request_fingerprint text
)
returns public.stocktakes
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  draft_row public.stocktakes;
  completed_row public.stocktakes;
begin
  current_account := private.current_account_id();
  if auth.uid() is null
     or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null
     or (not private.has_role('HR') and not private.has_role('WAREHOUSE')) then
    raise exception using errcode = '42501', message = 'HR or WAREHOUSE role is required';
  end if;

  if p_stocktake_id is null then
    draft_row := public.create_stocktake_draft(
      p_stocktake_no,
      p_warehouse_id,
      p_note,
      p_lines,
      p_create_idempotency_key,
      p_create_request_fingerprint
    );
  else
    draft_row := public.update_stocktake_draft(
      p_stocktake_id,
      p_note,
      p_lines,
      false,
      p_update_idempotency_key,
      p_update_request_fingerprint
    );
  end if;

  if draft_row.id is null then
    raise exception 'Stocktake completion did not produce a draft';
  end if;

  completed_row := public.post_stocktake(
    draft_row.id,
    p_post_idempotency_key,
    p_post_request_fingerprint
  );
  return completed_row;
end;
$$;

revoke all on function public.complete_stocktake(uuid, text, uuid, text, jsonb, text, text, text, text, text, text)
  from public, anon;
grant execute on function public.complete_stocktake(uuid, text, uuid, text, jsonb, text, text, text, text, text, text)
  to authenticated;

-- Source: supabase/migrations/0128_atomic_hr_request_submission.sql
do $migration$
begin
  if to_regprocedure(
    'public.create_hr_request_draft(text, date, text, jsonb, jsonb, text, text)'
  ) is null then
    raise exception using
      errcode = '42883',
      message = '0128 requires public.create_hr_request_draft(text, date, text, jsonb, jsonb, text, text)';
  end if;

  if to_regprocedure(
    'public.update_hr_request_draft(uuid, date, text, jsonb, jsonb, text, text)'
  ) is null then
    raise exception using
      errcode = '42883',
      message = '0128 requires public.update_hr_request_draft(uuid, date, text, jsonb, jsonb, text, text)';
  end if;

  if to_regprocedure('public.submit_hr_request(uuid, text, text)') is null then
    raise exception using
      errcode = '42883',
      message = '0128 requires public.submit_hr_request(uuid, text, text)';
  end if;
end;
$migration$;

-- PostgREST executes this wrapper in one transaction. Reuse the established
-- draft and submit RPCs so their row validation, lock ordering, reservations,
-- operation-command idempotency and audit behavior remain authoritative.
create or replace function public.submit_hr_request_with_lines(
  p_request_id uuid,
  p_request_no text,
  p_distribution_date date,
  p_note text,
  p_issue_lines jsonb,
  p_increase_lines jsonb,
  p_create_idempotency_key text,
  p_create_request_fingerprint text,
  p_update_idempotency_key text,
  p_update_request_fingerprint text,
  p_submit_idempotency_key text,
  p_submit_request_fingerprint text
)
returns public.hr_requests
language plpgsql
security definer
set search_path = pg_catalog, private
as $function$
declare
  current_account uuid;
  draft_row public.hr_requests;
  submitted_row public.hr_requests;
begin
  current_account := private.current_account_id();
  if auth.uid() is null
     or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null
     or not private.has_role('HR') then
    raise exception using errcode = '42501', message = 'HR role is required';
  end if;

  if p_request_id is null then
    draft_row := public.create_hr_request_draft(
      p_request_no,
      p_distribution_date,
      p_note,
      p_issue_lines,
      p_increase_lines,
      p_create_idempotency_key,
      p_create_request_fingerprint
    );
  else
    draft_row := public.update_hr_request_draft(
      p_request_id,
      p_distribution_date,
      p_note,
      p_issue_lines,
      p_increase_lines,
      p_update_idempotency_key,
      p_update_request_fingerprint
    );
  end if;

  if draft_row.id is null then
    raise exception 'HR request submission did not produce a draft';
  end if;

  submitted_row := public.submit_hr_request(
    draft_row.id,
    p_submit_idempotency_key,
    p_submit_request_fingerprint
  );
  return submitted_row;
end;
$function$;

revoke all on function public.submit_hr_request_with_lines(
  uuid, text, date, text, jsonb, jsonb, text, text, text, text, text, text
) from public, anon;
grant execute on function public.submit_hr_request_with_lines(
  uuid, text, date, text, jsonb, jsonb, text, text, text, text, text, text
) to authenticated;

-- Source: supabase/migrations/0129_overview_core_account_binding.sql
-- Bind the overview's authorization snapshot to the account resolved by the
-- same SQL statement. The browser can start this read while its identity query
-- is still running, then discard the payload if the account IDs do not match.
create or replace view public.v_overview_core
with (security_invoker = true)
as
select
  'current'::text as snapshot_key,
  coalesce((
    select jsonb_agg(to_jsonb(source_row) order by source_row.item_code)
    from (
      select item_code, item_name, available_to_request_quantity,
        combined_on_hand_quantity, active_reserved_quantity
      from public.v_item_availability
      order by item_code
      limit 300
    ) source_row
  ), '[]'::jsonb) as availability,
  coalesce((
    select jsonb_agg(to_jsonb(source_row) order by source_row.created_at desc)
    from (
      select request_id, request_no, status, distribution_date, created_at,
        requested_transfer_quantity
      from public.v_hr_request_item_totals
      order by created_at desc
      limit 300
    ) source_row
  ), '[]'::jsonb) as hr_requests,
  coalesce((
    select jsonb_agg(to_jsonb(source_row) order by source_row.distribution_date)
    from (
      select shipment_id, shipment_no, request_no, distribution_date,
        needs_warehouse_attention
      from public.v_pending_warehouse_shipments
      order by distribution_date
      limit 300
    ) source_row
  ), '[]'::jsonb) as shipments,
  coalesce((
    select jsonb_agg(to_jsonb(source_row) order by source_row.remaining_to_accept desc)
    from (
      select purchase_order_id, po_no, ordered_quantity, accepted_to_date,
        remaining_to_accept
      from public.v_purchase_order_receipt_progress
      order by remaining_to_accept desc
      limit 300
    ) source_row
  ), '[]'::jsonb) as receipts,
  (
    select account_row.id
    from public.app_accounts account_row
    where account_row.auth_user_id = auth.uid()
  ) as account_id;

revoke all on table public.v_overview_core from public, anon, authenticated;
grant select on public.v_overview_core to authenticated;

-- Source: supabase/migrations/0130_atomic_replenishment_submission.sql
do $migration$
begin
  if to_regprocedure(
    'public.create_replenishment_draft(text, text, jsonb, text, text)'
  ) is null then
    raise exception using
      errcode = '42883',
      message = '0130 requires public.create_replenishment_draft(text, text, jsonb, text, text)';
  end if;

  if to_regprocedure(
    'public.update_replenishment_request_draft(uuid, text, jsonb, text, text)'
  ) is null then
    raise exception using
      errcode = '42883',
      message = '0130 requires public.update_replenishment_request_draft(uuid, text, jsonb, text, text)';
  end if;

  if to_regprocedure('public.submit_replenishment_request(uuid, text, text)') is null then
    raise exception using
      errcode = '42883',
      message = '0130 requires public.submit_replenishment_request(uuid, text, text)';
  end if;
end;
$migration$;

-- PostgREST runs the wrapper and its established idempotent draft/submit RPCs
-- in one transaction, preserving their authorization, validation, locks and audit.
create or replace function public.submit_replenishment_request_with_lines(
  p_request_id uuid,
  p_request_no text,
  p_note text,
  p_lines jsonb,
  p_create_idempotency_key text,
  p_create_request_fingerprint text,
  p_update_idempotency_key text,
  p_update_request_fingerprint text,
  p_submit_idempotency_key text,
  p_submit_request_fingerprint text
)
returns public.replenishment_requests
language plpgsql
security definer
set search_path = pg_catalog, private
as $function$
declare
  current_account uuid;
  draft_row public.replenishment_requests;
  submitted_row public.replenishment_requests;
begin
  current_account := private.current_account_id();
  if auth.uid() is null
     or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null
     or not private.has_role('HR') then
    raise exception using errcode = '42501', message = 'HR role is required';
  end if;

  if p_request_id is null then
    draft_row := public.create_replenishment_draft(
      p_request_no,
      p_note,
      p_lines,
      p_create_idempotency_key,
      p_create_request_fingerprint
    );
  else
    draft_row := public.update_replenishment_request_draft(
      p_request_id,
      p_note,
      p_lines,
      p_update_idempotency_key,
      p_update_request_fingerprint
    );
  end if;

  if draft_row.id is null then
    raise exception 'Replenishment submission did not produce a draft';
  end if;

  submitted_row := public.submit_replenishment_request(
    draft_row.id,
    p_submit_idempotency_key,
    p_submit_request_fingerprint
  );
  return submitted_row;
end;
$function$;

revoke all on function public.submit_replenishment_request_with_lines(
  uuid, text, text, jsonb, text, text, text, text, text, text
) from public, anon;
grant execute on function public.submit_replenishment_request_with_lines(
  uuid, text, text, jsonb, text, text, text, text, text, text
) to authenticated;

-- Source: supabase/migrations/0131_atomic_correction_completion.sql
-- Keep the primary one-click correction path to one PostgREST round trip.
-- Each wrapper delegates validation, authorization, idempotency, inventory
-- locks, ledger changes, reconciliation, and audit to the existing RPCs.
-- The wrapper is SECURITY INVOKER so the authenticated caller remains the actor.

create or replace function public.complete_return_correction(
  p_correction_no text,
  p_original_return_line_id uuid,
  p_return_quantity_delta bigint,
  p_reason text,
  p_note text,
  p_create_idempotency_key text,
  p_create_request_fingerprint text,
  p_post_idempotency_key text,
  p_post_request_fingerprint text
)
returns public.correction_notes
language plpgsql
security invoker
set search_path = pg_catalog, private
as $$
declare
  correction_row public.correction_notes;
begin
  correction_row := public.create_return_correction_draft(
    p_correction_no, p_original_return_line_id, p_return_quantity_delta,
    p_reason, p_note, p_create_idempotency_key, p_create_request_fingerprint
  );
  if correction_row.id is null then raise exception 'Return correction creation returned no record'; end if;
  if correction_row.status = 'POSTED' then return correction_row; end if;
  if correction_row.status <> 'DRAFT' then raise exception 'Return correction is not postable'; end if;
  return public.post_return_correction(
    correction_row.id, p_post_idempotency_key, p_post_request_fingerprint
  );
end;
$$;

create or replace function public.complete_hr_issue_correction(
  p_correction_no text,
  p_original_issue_line_id uuid,
  p_issue_quantity_delta bigint,
  p_reason text,
  p_note text,
  p_create_idempotency_key text,
  p_create_request_fingerprint text,
  p_post_idempotency_key text,
  p_post_request_fingerprint text
)
returns public.correction_notes
language plpgsql
security invoker
set search_path = pg_catalog, private
as $$
declare
  correction_row public.correction_notes;
begin
  correction_row := public.create_hr_issue_correction_draft(
    p_correction_no, p_original_issue_line_id, p_issue_quantity_delta,
    p_reason, p_note, p_create_idempotency_key, p_create_request_fingerprint
  );
  if correction_row.id is null then raise exception 'HR issue correction creation returned no record'; end if;
  if correction_row.status = 'POSTED' then return correction_row; end if;
  if correction_row.status <> 'DRAFT' then raise exception 'HR issue correction is not postable'; end if;
  return public.post_hr_issue_correction(
    correction_row.id, p_post_idempotency_key, p_post_request_fingerprint
  );
end;
$$;

create or replace function public.complete_warehouse_transfer_correction(
  p_correction_no text,
  p_source_kind text,
  p_source_line_id uuid,
  p_transfer_quantity_delta bigint,
  p_reason text,
  p_note text,
  p_create_idempotency_key text,
  p_create_request_fingerprint text,
  p_post_idempotency_key text,
  p_post_request_fingerprint text
)
returns public.correction_notes
language plpgsql
security invoker
set search_path = pg_catalog, private
as $$
declare
  correction_row public.correction_notes;
begin
  correction_row := public.create_warehouse_transfer_correction_draft(
    p_correction_no, p_source_kind, p_source_line_id, p_transfer_quantity_delta,
    p_reason, p_note, p_create_idempotency_key, p_create_request_fingerprint
  );
  if correction_row.id is null then raise exception 'Transfer correction creation returned no record'; end if;
  if correction_row.status = 'POSTED' then return correction_row; end if;
  if correction_row.status <> 'DRAFT' then raise exception 'Transfer correction is not postable'; end if;
  return public.post_warehouse_transfer_correction(
    correction_row.id, p_post_idempotency_key, p_post_request_fingerprint
  );
end;
$$;

create or replace function public.complete_purchase_receipt_correction(
  p_correction_no text,
  p_original_receipt_line_id uuid,
  p_delivered_quantity_delta bigint,
  p_accepted_quantity_delta bigint,
  p_rejected_quantity_delta bigint,
  p_rejection_reason text,
  p_reason text,
  p_create_idempotency_key text,
  p_create_request_fingerprint text,
  p_post_idempotency_key text,
  p_post_request_fingerprint text
)
returns public.correction_notes
language plpgsql
security invoker
set search_path = pg_catalog, private
as $$
declare
  correction_row public.correction_notes;
begin
  correction_row := public.create_purchase_receipt_correction_draft(
    p_correction_no, p_original_receipt_line_id, p_delivered_quantity_delta,
    p_accepted_quantity_delta, p_rejected_quantity_delta, p_rejection_reason,
    p_reason, p_create_idempotency_key, p_create_request_fingerprint
  );
  if correction_row.id is null then raise exception 'Receipt correction creation returned no record'; end if;
  if correction_row.status = 'POSTED' then return correction_row; end if;
  if correction_row.status <> 'DRAFT' then raise exception 'Receipt correction is not postable'; end if;
  return public.post_purchase_receipt_correction(
    correction_row.id, p_post_idempotency_key, p_post_request_fingerprint
  );
end;
$$;

create or replace function public.complete_stocktake_correction(
  p_correction_no text,
  p_original_stocktake_line_id uuid,
  p_counted_quantity_delta bigint,
  p_reason text,
  p_note text,
  p_create_idempotency_key text,
  p_create_request_fingerprint text,
  p_post_idempotency_key text,
  p_post_request_fingerprint text
)
returns public.correction_notes
language plpgsql
security invoker
set search_path = pg_catalog, private
as $$
declare
  correction_row public.correction_notes;
begin
  correction_row := public.create_stocktake_correction_draft(
    p_correction_no, p_original_stocktake_line_id, p_counted_quantity_delta,
    p_reason, p_note, p_create_idempotency_key, p_create_request_fingerprint
  );
  if correction_row.id is null then raise exception 'Stocktake correction creation returned no record'; end if;
  if correction_row.status = 'POSTED' then return correction_row; end if;
  if correction_row.status <> 'DRAFT' then raise exception 'Stocktake correction is not postable'; end if;
  return public.post_stocktake_correction(
    correction_row.id, p_post_idempotency_key, p_post_request_fingerprint
  );
end;
$$;

revoke all on function public.complete_return_correction(text, uuid, bigint, text, text, text, text, text, text) from public, anon;
revoke all on function public.complete_hr_issue_correction(text, uuid, bigint, text, text, text, text, text, text) from public, anon;
revoke all on function public.complete_warehouse_transfer_correction(text, text, uuid, bigint, text, text, text, text, text, text) from public, anon;
revoke all on function public.complete_purchase_receipt_correction(text, uuid, bigint, bigint, bigint, text, text, text, text, text, text) from public, anon;
revoke all on function public.complete_stocktake_correction(text, uuid, bigint, text, text, text, text, text, text) from public, anon;

grant execute on function public.complete_return_correction(text, uuid, bigint, text, text, text, text, text, text) to authenticated;
grant execute on function public.complete_hr_issue_correction(text, uuid, bigint, text, text, text, text, text, text) to authenticated;
grant execute on function public.complete_warehouse_transfer_correction(text, text, uuid, bigint, text, text, text, text, text, text) to authenticated;
grant execute on function public.complete_purchase_receipt_correction(text, uuid, bigint, bigint, bigint, text, text, text, text, text, text) to authenticated;
grant execute on function public.complete_stocktake_correction(text, uuid, bigint, text, text, text, text, text, text) to authenticated;

-- Source: supabase/migrations/0132_atomic_return_completion.sql
-- Complete the common one-step return path in one database transaction and
-- one browser round trip, reusing the existing guarded and idempotent RPCs.
create or replace function public.complete_return_note(
  p_return_no text,
  p_original_hr_request_id uuid,
  p_return_date date,
  p_reason_code text,
  p_reason text,
  p_note text,
  p_lines jsonb,
  p_create_idempotency_key text,
  p_create_request_fingerprint text,
  p_post_idempotency_key text,
  p_post_request_fingerprint text
)
returns public.return_notes
language plpgsql
security invoker
set search_path = pg_catalog, private
as $$
declare
  return_row public.return_notes;
begin
  return_row := public.create_return_note_draft(
    p_return_no,
    p_original_hr_request_id,
    p_return_date,
    p_reason_code,
    p_reason,
    p_note,
    p_lines,
    p_create_idempotency_key,
    p_create_request_fingerprint
  );

  if return_row.id is null then
    raise exception 'Return draft creation returned no record';
  end if;
  -- A retry after a committed response loss replays the create idempotency key;
  -- the existing draft RPC returns the already-posted row in that case.
  if return_row.status = 'POSTED' then
    return return_row;
  end if;
  if return_row.status <> 'DRAFT' then
    raise exception 'Return note is not postable';
  end if;

  return public.post_return_note(
    return_row.id,
    p_post_idempotency_key,
    p_post_request_fingerprint
  );
end;
$$;

revoke all on function public.complete_return_note(text, uuid, date, text, text, text, jsonb, text, text, text, text)
  from public, anon;
grant execute on function public.complete_return_note(text, uuid, date, text, text, text, jsonb, text, text, text, text)
  to authenticated;

-- Fail the transaction unless the published read models, indexes, and RPCs are ready.
do $read_model_postflight$
declare
  incomplete_views text;
  incomplete_indexes text;
  incomplete_functions text;
  remaining_redundant_indexes text;
  overview_identity_binding_ready boolean;
begin
  select string_agg(required.name, ', ' order by required.name)
    into incomplete_views
  from (values
    ('v_account_directory'),
    ('v_correction_history'),
    ('v_employee_directory'),
    ('v_hr_issue_correction_sources'),
    ('v_hr_request_employee_options'),
    ('v_hr_request_history'),
    ('v_hr_request_history_detail'),
    ('v_hr_request_item_options'),
    ('v_overview_core'),
    ('v_purchase_receipt_correction_sources'),
    ('v_replenishment_shipment_lines'),
    ('v_return_correction_sources'),
    ('v_seasonal_approval_queue'),
    ('v_seasonal_demand_workspace'),
    ('v_seasonal_procurement_queue'),
    ('v_stocktake_correction_sources'),
    ('v_warehouse_shipment_lines'),
    ('v_warehouse_shipment_queue'),
    ('v_warehouse_transfer_correction_sources')
  ) as required(name)
  left join pg_class relation_row
    on relation_row.relnamespace = 'public'::regnamespace
   and relation_row.relname = required.name
  where relation_row.oid is null
     or not coalesce(relation_row.reloptions @> array['security_invoker=true'], false)
     or not coalesce(has_table_privilege('authenticated', relation_row.oid, 'SELECT'), false);

  if incomplete_views is not null then
    raise exception using
      errcode = '55000',
      message = 'Read-model view verification failed: ' || incomplete_views;
  end if;

  select exists (
    select 1
    from pg_attribute attribute_row
    where attribute_row.attrelid = 'public.v_overview_core'::regclass
      and attribute_row.attname = 'account_id'
      and not attribute_row.attisdropped
  ) into overview_identity_binding_ready;

  if not overview_identity_binding_ready then
    raise exception using
      errcode = '55000',
      message = 'Overview account snapshot binding is missing.';
  end if;

  select string_agg(required.name, ', ' order by required.name)
    into incomplete_indexes
  from (values
    ('inventory_balances_item_warehouse_read_idx'),
    ('hr_issue_lines_request_item_read_idx'),
    ('purchase_receipt_lines_order_line_read_idx'),
    ('purchase_receipt_correction_lines_source_read_idx'),
    ('audit_events_occurred_at_read_idx'),
    ('purchase_orders_open_po_no_idx'),
    ('purchase_receipts_posted_receipt_no_idx'),
    ('hr_requests_shipped_distribution_date_idx'),
    ('return_notes_posted_id_idx'),
    ('correction_notes_purchase_receipt_source_idx'),
    ('correction_notes_return_note_source_idx'),
    ('correction_notes_hr_request_source_idx'),
    ('correction_notes_stocktake_source_idx'),
    ('correction_notes_warehouse_shipment_source_idx'),
    ('correction_notes_replenishment_source_idx'),
    ('hr_requests_created_at_idx'),
    ('inventory_reservations_source_status_idx'),
    ('app_accounts_email_snapshot_idx'),
    ('return_correction_lines_source_read_idx'),
    ('issue_correction_lines_source_read_idx'),
    ('warehouse_transfer_correction_lines_shipment_source_read_idx'),
    ('warehouse_transfer_correction_lines_replenishment_source_read_idx'),
    ('stocktake_correction_lines_source_read_idx'),
    ('import_batches_work_queue_idx')
  ) as required(name)
  left join pg_class index_row
    on index_row.relnamespace = 'public'::regnamespace
   and index_row.relname = required.name
  left join pg_index index_definition
    on index_definition.indexrelid = index_row.oid
  where index_row.oid is null
     or not coalesce(index_definition.indisvalid, false)
     or not coalesce(index_definition.indisready, false);

  if incomplete_indexes is not null then
    raise exception using
      errcode = '55000',
      message = 'Read-path index verification failed: ' || incomplete_indexes;
  end if;

  select string_agg(required.signature, ', ' order by required.signature)
    into incomplete_functions
  from (values
    ('recapture_stocktake_draft(uuid,text,text,text)'),
    ('post_warehouse_shipment_with_lines(uuid,jsonb,text,text)'),
    ('create_seasonal_campaign_with_scope(text,text,text,date,date,timestamptz,timestamptz,uuid[],uuid[],text,text,text,text)'),
    ('complete_purchase_receipt(text,uuid,bigint,bigint,bigint,text,date,text,text,text,text)'),
    ('complete_stocktake(uuid,text,uuid,text,jsonb,text,text,text,text,text,text)'),
    ('submit_hr_request_with_lines(uuid,text,date,text,jsonb,jsonb,text,text,text,text,text,text)'),
    ('submit_replenishment_request_with_lines(uuid,text,text,jsonb,text,text,text,text,text,text)'),
    ('complete_return_correction(text,uuid,bigint,text,text,text,text,text,text)'),
    ('complete_hr_issue_correction(text,uuid,bigint,text,text,text,text,text,text)'),
    ('complete_warehouse_transfer_correction(text,text,uuid,bigint,text,text,text,text,text,text)'),
    ('complete_purchase_receipt_correction(text,uuid,bigint,bigint,bigint,text,text,text,text,text,text)'),
    ('complete_stocktake_correction(text,uuid,bigint,text,text,text,text,text,text)'),
    ('complete_return_note(text,uuid,date,text,text,text,jsonb,text,text,text,text)')
  ) as required(signature)
  where to_regprocedure('public.' || required.signature) is null
     or not coalesce(
       has_function_privilege('authenticated', to_regprocedure('public.' || required.signature), 'EXECUTE'),
       false
     );

  if incomplete_functions is not null then
    raise exception using
      errcode = '55000',
      message = 'Atomic-workflow RPC verification failed: ' || incomplete_functions;
  end if;

  select string_agg(required.name, ', ' order by required.name)
    into remaining_redundant_indexes
  from (values
    ('operation_commands_operation_idempotency_conflict_idx'),
    ('institutions_code_conflict_idx'),
    ('departments_institution_code_conflict_idx'),
    ('uniform_items_item_code_conflict_idx'),
    ('suppliers_supplier_code_conflict_idx'),
    ('supplier_uniform_items_supplier_item_conflict_idx')
  ) as required(name)
  join pg_class index_row
    on index_row.relnamespace = 'public'::regnamespace
   and index_row.relname = required.name;

  if remaining_redundant_indexes is not null then
    raise exception using
      errcode = '55000',
      message = 'Redundant master-data indexes remain: ' || remaining_redundant_indexes;
  end if;
end;
$read_model_postflight$;

select
  (select count(*) from (values
    ('v_account_directory'),
    ('v_correction_history'),
    ('v_employee_directory'),
    ('v_hr_issue_correction_sources'),
    ('v_hr_request_employee_options'),
    ('v_hr_request_history'),
    ('v_hr_request_history_detail'),
    ('v_hr_request_item_options'),
    ('v_overview_core'),
    ('v_purchase_receipt_correction_sources'),
    ('v_replenishment_shipment_lines'),
    ('v_return_correction_sources'),
    ('v_seasonal_approval_queue'),
    ('v_seasonal_demand_workspace'),
    ('v_seasonal_procurement_queue'),
    ('v_stocktake_correction_sources'),
    ('v_warehouse_shipment_lines'),
    ('v_warehouse_shipment_queue'),
    ('v_warehouse_transfer_correction_sources')
  ) as required(name)
   join pg_class relation_row
     on relation_row.relnamespace = 'public'::regnamespace
    and relation_row.relname = required.name) as read_views_ready,
  (select count(*) from pg_indexes where schemaname = 'public' and indexname in (
    'inventory_balances_item_warehouse_read_idx',
    'hr_issue_lines_request_item_read_idx',
    'purchase_receipt_lines_order_line_read_idx',
    'purchase_receipt_correction_lines_source_read_idx',
    'audit_events_occurred_at_read_idx',
    'purchase_orders_open_po_no_idx',
    'purchase_receipts_posted_receipt_no_idx',
    'hr_requests_shipped_distribution_date_idx',
    'return_notes_posted_id_idx',
    'correction_notes_purchase_receipt_source_idx',
    'correction_notes_return_note_source_idx',
    'correction_notes_hr_request_source_idx',
    'correction_notes_stocktake_source_idx',
    'correction_notes_warehouse_shipment_source_idx',
    'correction_notes_replenishment_source_idx',
    'hr_requests_created_at_idx',
    'inventory_reservations_source_status_idx',
    'app_accounts_email_snapshot_idx',
    'return_correction_lines_source_read_idx',
    'issue_correction_lines_source_read_idx',
    'warehouse_transfer_correction_lines_shipment_source_read_idx',
    'warehouse_transfer_correction_lines_replenishment_source_read_idx',
    'stocktake_correction_lines_source_read_idx',
    'import_batches_work_queue_idx'
  )) as read_indexes_ready,
  (select count(*) from (values
    ('recapture_stocktake_draft(uuid,text,text,text)'),
    ('post_warehouse_shipment_with_lines(uuid,jsonb,text,text)'),
    ('create_seasonal_campaign_with_scope(text,text,text,date,date,timestamptz,timestamptz,uuid[],uuid[],text,text,text,text)'),
    ('complete_purchase_receipt(text,uuid,bigint,bigint,bigint,text,date,text,text,text,text)'),
    ('complete_stocktake(uuid,text,uuid,text,jsonb,text,text,text,text,text,text)'),
    ('submit_hr_request_with_lines(uuid,text,date,text,jsonb,jsonb,text,text,text,text,text,text)'),
    ('submit_replenishment_request_with_lines(uuid,text,text,jsonb,text,text,text,text,text,text)'),
    ('complete_return_correction(text,uuid,bigint,text,text,text,text,text,text)'),
    ('complete_hr_issue_correction(text,uuid,bigint,text,text,text,text,text,text)'),
    ('complete_warehouse_transfer_correction(text,text,uuid,bigint,text,text,text,text,text,text)'),
    ('complete_purchase_receipt_correction(text,uuid,bigint,bigint,bigint,text,text,text,text,text,text)'),
    ('complete_stocktake_correction(text,uuid,bigint,text,text,text,text,text,text)'),
    ('complete_return_note(text,uuid,date,text,text,text,jsonb,text,text,text,text)')
  ) as required(signature)
   where to_regprocedure('public.' || required.signature) is not null) as optimized_rpcs_ready,
  (select count(*) from pg_indexes where schemaname = 'public' and indexname in (
    'operation_commands_operation_idempotency_conflict_idx',
    'institutions_code_conflict_idx',
    'departments_institution_code_conflict_idx',
    'uniform_items_item_code_conflict_idx',
    'suppliers_supplier_code_conflict_idx',
    'supplier_uniform_items_supplier_item_conflict_idx'
  )) as redundant_indexes_remaining;


commit;
