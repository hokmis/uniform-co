-- Forward fix for 0063: aggregate receipt corrections at PO-line grain before
-- joining the already aggregated posted receipt totals.  Joining receipt_totals
-- to raw receipt lines multiplies totals when a line is received in batches.

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
), correction_totals_by_po_line as (
  select
    source_line.purchase_order_line_id,
    coalesce(sum(cl.delivered_quantity_delta), 0)::bigint as delivered_delta,
    coalesce(sum(cl.accepted_quantity_delta), 0)::bigint as accepted_delta,
    coalesce(sum(cl.rejected_quantity_delta), 0)::bigint as rejected_delta
  from public.purchase_receipt_correction_lines cl
  join public.correction_notes cn on cn.id = cl.correction_note_id
  join public.purchase_receipt_lines source_line
    on source_line.id = cl.original_receipt_line_id
   and source_line.receipt_id = cl.original_purchase_receipt_id
  where cn.status = 'POSTED'
  group by source_line.purchase_order_line_id
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
    (coalesce(rt.delivered_quantity, 0) + coalesce(ct.delivered_delta, 0))::bigint as delivered_to_date,
    (coalesce(rt.accepted_quantity, 0) + coalesce(ct.accepted_delta, 0))::bigint as accepted_to_date,
    (coalesce(rt.rejected_quantity, 0) + coalesce(ct.rejected_delta, 0))::bigint as rejected_to_date
  from public.purchase_order_lines pol
  left join receipt_totals rt on rt.purchase_order_line_id = pol.id
  left join correction_totals_by_po_line ct on ct.purchase_order_line_id = pol.id
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
