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
