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
