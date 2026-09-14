-- Add the human-readable source number required by the inventory history
-- report.  source_entity_id remains available for exact joins; the number is
-- resolved from the immutable source table according to posting_kind.

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
    case p.posting_kind
      when 'WAREHOUSE_SHIPMENT' then (select s.shipment_no from public.warehouse_shipments s where s.id = p.source_entity_id)
      when 'REPLENISHMENT' then (select r.request_no from public.replenishment_requests r where r.id = p.source_entity_id)
      when 'RECEIPT' then (select r.receipt_no from public.purchase_receipts r where r.id = p.source_entity_id)
      when 'STOCKTAKE' then (select s.stocktake_no from public.stocktakes s where s.id = p.source_entity_id)
      when 'RETURN' then (select r.return_no from public.return_notes r where r.id = p.source_entity_id)
      when 'OPENING' then (
        select b.batch_no
        from public.opening_posting_sources ops
        join public.opening_balance_batches b on b.id = ops.batch_id
        where ops.posting_id = p.id
      )
      when 'CORRECTION' then (
        select c.correction_no
        from public.correction_posting_sources cps
        join public.correction_notes c on c.id = cps.correction_note_id
        where cps.posting_id = p.id
      )
      else null
    end as source_no,
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
  current_on_hand_quantity,
  source_no
from ordered_entries;
