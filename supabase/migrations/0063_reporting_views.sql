-- Read-only reporting views.  These views deliberately derive every quantity
-- from the immutable source tables, ledger entries, balances, or frozen
-- snapshots; they do not introduce a second mutable reporting store.

create or replace view public.v_item_availability
with (security_invoker = true)
as
with balance_totals as (
  select
    b.item_id,
    coalesce(sum(b.on_hand_quantity) filter (where w.purpose = 'HR'), 0)::bigint as hr_on_hand_quantity,
    coalesce(sum(b.on_hand_quantity) filter (where w.purpose = 'GENERAL'), 0)::bigint as general_on_hand_quantity
  from public.inventory_balances b
  join public.warehouses w on w.id = b.warehouse_id
  group by b.item_id
), reservation_totals as (
  select item_id, coalesce(sum(quantity), 0)::bigint as active_reserved_quantity
  from public.inventory_reservations
  where status = 'ACTIVE'
  group by item_id
)
select
  i.id as item_id,
  i.item_code,
  i.item_name,
  i.unit,
  i.size,
  i.category,
  i.season,
  i.is_active,
  coalesce(b.hr_on_hand_quantity, 0)::bigint as hr_on_hand_quantity,
  coalesce(b.general_on_hand_quantity, 0)::bigint as general_on_hand_quantity,
  (coalesce(b.hr_on_hand_quantity, 0) + coalesce(b.general_on_hand_quantity, 0))::bigint as combined_on_hand_quantity,
  coalesce(r.active_reserved_quantity, 0)::bigint as active_reserved_quantity,
  (coalesce(b.hr_on_hand_quantity, 0) + coalesce(b.general_on_hand_quantity, 0)
    - coalesce(r.active_reserved_quantity, 0))::bigint as available_to_request_quantity
from public.uniform_items i
left join balance_totals b on b.item_id = i.id
left join reservation_totals r on r.item_id = i.id;

create or replace view public.v_hr_request_item_totals
with (security_invoker = true)
as
select
  r.id as request_id,
  r.request_no,
  r.status,
  r.distribution_date,
  r.created_at,
  ri.item_id,
  coalesce(ri.item_code_snapshot, i.item_code) as item_code,
  coalesce(ri.item_name_snapshot, i.item_name) as item_name,
  coalesce(ri.unit_snapshot, i.unit) as unit,
  ri.issue_quantity,
  ri.increase_quantity,
  ri.requested_transfer_quantity,
  coalesce(sum(l.quantity), 0)::bigint as issue_line_quantity,
  count(l.id)::integer as issue_line_count
from public.hr_requests r
join public.hr_request_items ri on ri.request_id = r.id
left join public.uniform_items i on i.id = ri.item_id
left join public.hr_issue_lines l on l.request_id = r.id and l.item_id = ri.item_id
group by r.id, r.request_no, r.status, r.distribution_date, r.created_at,
  ri.item_id, ri.item_code_snapshot, ri.item_name_snapshot, ri.unit_snapshot,
  i.item_code, i.item_name, i.unit, ri.issue_quantity, ri.increase_quantity,
  ri.requested_transfer_quantity;

create or replace view public.v_pending_warehouse_shipments
with (security_invoker = true)
as
select
  s.id as shipment_id,
  s.shipment_no,
  s.status as shipment_status,
  s.created_by,
  s.note as shipment_note,
  r.id as request_id,
  r.request_no,
  r.distribution_date,
  l.id as shipment_line_id,
  l.hr_request_item_id,
  l.item_id,
  l.requested_transfer_quantity_snapshot,
  l.general_on_hand_snapshot,
  l.maximum_transfer_quantity_snapshot,
  l.actual_transfer_quantity,
  l.transfer_difference_quantity,
  l.short_ship_reason_code,
  (l.actual_transfer_quantity is not null) as is_line_ready,
  (l.actual_transfer_quantity is null
    or l.transfer_difference_quantity > 0) as needs_warehouse_attention
from public.warehouse_shipments s
join public.hr_requests r on r.id = s.hr_request_id
join public.warehouse_shipment_lines l on l.shipment_id = s.id
where s.status = 'DRAFT';

create or replace view public.v_inventory_history
with (security_invoker = true)
as
with ordered_entries as (
  select
    le.id as ledger_entry_id,
    le.posting_id,
    le.line_no,
    le.warehouse_id,
    le.item_id,
    le.movement_kind,
    le.quantity_delta,
    le.occurred_on,
    p.posting_kind,
    p.source_entity_id,
    p.idempotency_key,
    p.posted_by,
    p.posted_at,
    coalesce(a.display_name, a.email_snapshot) as posted_by_name,
    w.code as warehouse_code,
    w.name as warehouse_name,
    w.purpose as warehouse_purpose,
    i.item_code,
    i.item_name,
    i.unit,
    b.on_hand_quantity as current_on_hand_quantity,
    coalesce(sum(le.quantity_delta) over (
      partition by le.warehouse_id, le.item_id
      order by p.posted_at, p.id, le.line_no
      rows between 1 following and unbounded following
    ), 0)::bigint as future_quantity_delta
  from public.inventory_ledger_entries le
  join public.inventory_postings p on p.id = le.posting_id
  join public.warehouses w on w.id = le.warehouse_id
  join public.uniform_items i on i.id = le.item_id
  left join public.app_accounts a on a.id = p.posted_by
  left join public.inventory_balances b
    on b.warehouse_id = le.warehouse_id and b.item_id = le.item_id
)
select
  ledger_entry_id,
  posting_id,
  line_no,
  warehouse_id,
  warehouse_code,
  warehouse_name,
  warehouse_purpose,
  item_id,
  item_code,
  item_name,
  unit,
  posting_kind,
  movement_kind,
  quantity_delta,
  occurred_on,
  source_entity_id,
  idempotency_key,
  posted_by,
  posted_by_name,
  posted_at,
  (current_on_hand_quantity - future_quantity_delta)::bigint as on_hand_after_entry,
  current_on_hand_quantity
from ordered_entries;

create or replace view public.v_employee_distribution_history
with (security_invoker = true)
as
select
  l.employee_id,
  l.employee_no_snapshot as employee_no,
  l.employee_name_snapshot as employee_name,
  l.item_id,
  l.item_code_snapshot as item_code,
  l.item_name_snapshot as item_name,
  l.size_snapshot as size,
  l.unit_snapshot as unit,
  r.id as source_id,
  r.request_no as source_no,
  r.distribution_date as occurred_on,
  'HR_ISSUE'::text as event_kind,
  l.quantity::bigint as quantity_delta,
  l.id as source_line_id
from public.hr_issue_lines l
join public.hr_requests r on r.id = l.request_id
where r.status = 'SHIPPED'
union all
select
  l.employee_id,
  l.employee_no_snapshot,
  l.employee_name_snapshot,
  l.item_id,
  l.item_code_snapshot,
  l.item_name_snapshot,
  l.size_snapshot,
  l.unit_snapshot,
  c.id,
  c.correction_no,
  c.posted_at::date,
  'HR_ISSUE_CORRECTION',
  l.issue_quantity_delta,
  l.id
from public.issue_correction_lines l
join public.correction_notes c on c.id = l.correction_note_id
where c.status = 'POSTED'
union all
select
  l.employee_id,
  l.employee_no_snapshot,
  l.employee_name_snapshot,
  l.item_id,
  l.item_code_snapshot,
  l.item_name_snapshot,
  l.size_snapshot,
  l.unit_snapshot,
  n.id,
  n.return_no,
  n.posted_at::date,
  'RETURN',
  (-l.quantity)::bigint,
  l.id
from public.return_lines l
join public.return_notes n on n.id = l.return_note_id
where n.status = 'POSTED'
union all
select
  l.employee_id,
  l.employee_no_snapshot,
  l.employee_name_snapshot,
  l.item_id,
  l.item_code_snapshot,
  l.item_name_snapshot,
  l.size_snapshot,
  l.unit_snapshot,
  c.id,
  c.correction_no,
  c.posted_at::date,
  'RETURN_CORRECTION',
  (-l.return_quantity_delta)::bigint,
  l.id
from public.return_correction_lines l
join public.correction_notes c on c.id = l.correction_note_id
where c.status = 'POSTED';

create or replace view public.v_seasonal_demand_summary
with (security_invoker = true)
as
select
  c.id as campaign_id,
  c.campaign_no,
  c.name as campaign_name,
  c.season,
  c.status as campaign_status,
  c.window_start,
  c.window_end,
  ce.institution_id_snapshot as institution_id,
  ce.department_id_snapshot as department_id,
  ci.item_id,
  ci.item_code_snapshot as item_code,
  ci.item_name_snapshot as item_name,
  ci.unit_snapshot as unit,
  count(distinct d.employee_id)::integer as employee_count,
  coalesce(sum(d.quantity), 0)::bigint as demand_quantity,
  count(d.id)::integer as demand_line_count
from public.seasonal_campaigns c
join public.seasonal_demand_lines d on d.campaign_id = c.id
join public.seasonal_campaign_employees ce
  on ce.campaign_id = d.campaign_id and ce.employee_id = d.employee_id
join public.seasonal_campaign_items ci
  on ci.campaign_id = d.campaign_id and ci.item_id = d.item_id
group by c.id, c.campaign_no, c.name, c.season, c.status, c.window_start, c.window_end,
  ce.institution_id_snapshot, ce.department_id_snapshot, ci.item_id,
  ci.item_code_snapshot, ci.item_name_snapshot, ci.unit_snapshot;

create or replace view public.v_purchase_order_receipt_progress
with (security_invoker = true)
as
with receipt_totals as (
  select
    prl.purchase_order_line_id,
    coalesce(sum(prl.delivered_quantity), 0)::bigint as delivered_quantity,
    coalesce(sum(prl.accepted_quantity), 0)::bigint as accepted_quantity,
    coalesce(sum(prl.rejected_quantity), 0)::bigint as rejected_quantity
  from public.purchase_receipt_lines prl
  join public.purchase_receipts pr on pr.id = prl.receipt_id
  where pr.status = 'POSTED'
  group by prl.purchase_order_line_id
), correction_totals as (
  select
    cl.original_receipt_line_id as receipt_line_id,
    coalesce(sum(cl.delivered_quantity_delta), 0)::bigint as delivered_delta,
    coalesce(sum(cl.accepted_quantity_delta), 0)::bigint as accepted_delta,
    coalesce(sum(cl.rejected_quantity_delta), 0)::bigint as rejected_delta
  from public.purchase_receipt_correction_lines cl
  join public.correction_notes cn on cn.id = cl.correction_note_id
  where cn.status = 'POSTED'
  group by cl.original_receipt_line_id
), effective_lines as (
  select
    pol.id as purchase_order_line_id,
    pol.purchase_order_id,
    pol.seasonal_procurement_line_id,
    pol.line_no,
    pol.item_id,
    pol.item_code_snapshot,
    pol.item_name_snapshot,
    pol.size_snapshot,
    pol.unit_snapshot,
    pol.ordered_quantity,
    coalesce(rt.delivered_quantity, 0)
      + coalesce(sum(ct.delivered_delta), 0)::bigint as delivered_to_date,
    coalesce(rt.accepted_quantity, 0)
      + coalesce(sum(ct.accepted_delta), 0)::bigint as accepted_to_date,
    coalesce(rt.rejected_quantity, 0)
      + coalesce(sum(ct.rejected_delta), 0)::bigint as rejected_to_date
  from public.purchase_order_lines pol
  left join receipt_totals rt on rt.purchase_order_line_id = pol.id
  left join public.purchase_receipt_lines source_line
    on source_line.purchase_order_line_id = pol.id
  left join correction_totals ct on ct.receipt_line_id = source_line.id
  group by pol.id, pol.purchase_order_id, pol.seasonal_procurement_line_id, pol.line_no,
    pol.item_id, pol.item_code_snapshot, pol.item_name_snapshot, pol.size_snapshot,
    pol.unit_snapshot, pol.ordered_quantity, rt.delivered_quantity,
    rt.accepted_quantity, rt.rejected_quantity
), limits as (
  select
    spl.id as seasonal_procurement_line_id,
    coalesce((
      select ch.new_purchase_limit_quantity
      from public.seasonal_procurement_line_changes ch
      where ch.procurement_line_id = spl.id
      order by ch.revision desc
      limit 1
    ), spl.final_purchase_quantity)::bigint as current_purchase_limit
  from public.seasonal_procurement_lines spl
), allocations as (
  select
    e.seasonal_procurement_line_id,
    coalesce(sum(case
      when po.status = 'CANCELLED' then 0
      when po.status = 'CLOSED_SHORT' then e.accepted_to_date
      else e.ordered_quantity
    end), 0)::bigint as allocated_quantity,
    count(distinct po.id)::integer as purchase_order_count
  from effective_lines e
  join public.purchase_orders po on po.id = e.purchase_order_id
  group by e.seasonal_procurement_line_id
)
select
  po.id as purchase_order_id,
  po.po_no,
  po.status as purchase_order_status,
  po.supplier_id,
  po.supplier_name_snapshot,
  pol.id as purchase_order_line_id,
  pol.line_no,
  pol.seasonal_procurement_line_id,
  e.item_id,
  e.item_code_snapshot as item_code,
  e.item_name_snapshot as item_name,
  e.size_snapshot as size,
  e.unit_snapshot as unit,
  e.ordered_quantity,
  l.current_purchase_limit,
  a.allocated_quantity,
  a.purchase_order_count,
  e.delivered_to_date,
  e.accepted_to_date,
  e.rejected_to_date,
  greatest(e.ordered_quantity - e.accepted_to_date, 0)::bigint as remaining_to_accept,
  case when po.status = 'CLOSED_SHORT'
    then greatest(e.ordered_quantity - e.accepted_to_date, 0)::bigint else 0::bigint end as closed_short_quantity,
  (e.accepted_to_date >= e.ordered_quantity) as line_fully_accepted
from effective_lines e
join public.purchase_orders po on po.id = e.purchase_order_id
join public.purchase_order_lines pol on pol.id = e.purchase_order_line_id
join limits l on l.seasonal_procurement_line_id = e.seasonal_procurement_line_id
join allocations a on a.seasonal_procurement_line_id = e.seasonal_procurement_line_id;

create or replace view public.v_erp_export_candidates
with (security_invoker = true)
as
select
  l.id as issue_line_id,
  r.id as request_id,
  r.request_no,
  r.distribution_date,
  l.employee_id,
  l.employee_no_snapshot as employee_no,
  l.employee_name_snapshot as employee_name,
  l.institution_id_snapshot as institution_id,
  l.institution_code_snapshot as institution_code,
  l.institution_name_snapshot as institution_name,
  l.department_id_snapshot as department_id,
  l.department_code_snapshot as department_code,
  l.department_name_snapshot as department_name,
  l.item_id,
  l.item_code_snapshot as item_code,
  l.item_name_snapshot as item_name,
  l.size_snapshot as size,
  l.unit_snapshot as unit,
  l.quantity
from public.hr_issue_lines l
join public.hr_requests r on r.id = l.request_id and r.status = 'SHIPPED'
where not exists (
  select 1 from public.erp_export_source_links sl where sl.issue_line_id = l.id
);

create or replace view public.v_audit_event_history
with (security_invoker = true)
as
select
  id,
  occurred_at,
  actor_account_id,
  action,
  entity_table,
  entity_id,
  before_data,
  after_data,
  reason,
  request_id,
  correlation_id,
  client_metadata
from public.audit_events;

revoke all on table public.v_item_availability,
  public.v_hr_request_item_totals,
  public.v_pending_warehouse_shipments,
  public.v_inventory_history,
  public.v_employee_distribution_history,
  public.v_seasonal_demand_summary,
  public.v_purchase_order_receipt_progress,
  public.v_erp_export_candidates,
  public.v_audit_event_history
from public, anon, authenticated;
grant select on public.v_item_availability,
  public.v_hr_request_item_totals,
  public.v_pending_warehouse_shipments,
  public.v_inventory_history,
  public.v_employee_distribution_history,
  public.v_seasonal_demand_summary,
  public.v_purchase_order_receipt_progress,
  public.v_erp_export_candidates,
  public.v_audit_event_history to authenticated;
