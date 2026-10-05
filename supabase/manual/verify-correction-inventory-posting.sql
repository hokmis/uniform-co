-- Read-only check for transfer/stocktake correction runtime readiness and recent evidence.
-- A completed transfer correction should have two balanced ledger rows (GENERAL + HR).
-- A completed stocktake correction should have exactly one non-zero ledger row.
-- Failed RPC transactions can roll back command rows, so zero rows only means there is no persisted command evidence; it does not prove no RPC attempt.
-- No business data is modified.

with readiness as (
  select
    to_regprocedure('public.complete_warehouse_transfer_correction(text,text,uuid,bigint,text,text,text,text,text,text)') is not null as transfer_completion_rpc_ready,
    coalesce(has_function_privilege('authenticated', to_regprocedure('public.complete_warehouse_transfer_correction(text,text,uuid,bigint,text,text,text,text,text,text)'), 'EXECUTE'), false) as transfer_completion_execute_granted,
    to_regprocedure('public.create_warehouse_transfer_correction_draft(text,text,uuid,bigint,text,text,text,text)') is not null as transfer_create_rpc_ready,
    coalesce(has_function_privilege('authenticated', to_regprocedure('public.create_warehouse_transfer_correction_draft(text,text,uuid,bigint,text,text,text,text)'), 'EXECUTE'), false) as transfer_create_execute_granted,
    to_regprocedure('public.post_warehouse_transfer_correction(uuid,text,text)') is not null as transfer_post_rpc_ready,
    coalesce(has_function_privilege('authenticated', to_regprocedure('public.post_warehouse_transfer_correction(uuid,text,text)'), 'EXECUTE'), false) as transfer_post_execute_granted,
    to_regprocedure('public.complete_stocktake_correction(text,uuid,bigint,text,text,text,text,text,text)') is not null as stocktake_completion_rpc_ready,
    coalesce(has_function_privilege('authenticated', to_regprocedure('public.complete_stocktake_correction(text,uuid,bigint,text,text,text,text,text,text)'), 'EXECUTE'), false) as stocktake_completion_execute_granted,
    to_regprocedure('public.create_stocktake_correction_draft(text,uuid,bigint,text,text,text,text)') is not null as stocktake_create_rpc_ready,
    coalesce(has_function_privilege('authenticated', to_regprocedure('public.create_stocktake_correction_draft(text,uuid,bigint,text,text,text,text)'), 'EXECUTE'), false) as stocktake_create_execute_granted,
    to_regprocedure('public.post_stocktake_correction(uuid,text,text)') is not null as stocktake_post_rpc_ready,
    coalesce(has_function_privilege('authenticated', to_regprocedure('public.post_stocktake_correction(uuid,text,text)'), 'EXECUTE'), false) as stocktake_post_execute_granted,
    exists (
      select 1
      from pg_catalog.pg_trigger t
      where t.tgrelid = to_regclass('public.correction_notes')::oid
        and t.tgname = 'correction_notes_inventory_effect_guard'
        and not t.tgisinternal
        and t.tgenabled in ('O', 'A')
        and t.tgfoid = to_regprocedure('private.assert_correction_inventory_effect()')::oid
    ) as inventory_effect_guard_ready
),
recent_corrections as (
  select
    c.id,
    c.correction_no,
    c.correction_kind,
    c.status,
    c.posted_at,
    coalesce(max(coalesce(oc.succeeded_at, oc.started_at)), c.posted_at) as operation_at
  from public.correction_notes c
  left join public.operation_commands oc
    on oc.result_entity_id = c.id and oc.result_entity_type = 'correction_notes'
  where c.correction_kind in ('WAREHOUSE_TRANSFER', 'STOCKTAKE')
  group by c.id, c.correction_no, c.correction_kind, c.status, c.posted_at
  order by coalesce(max(coalesce(oc.succeeded_at, oc.started_at)), c.posted_at) desc nulls last, c.id desc
  limit 50
),
operation_summary as (
  select
    requested.operation_code,
    count(oc.id)::integer as operation_count,
    count(oc.id) filter (where oc.status = 'SUCCEEDED')::integer as succeeded_count,
    max(coalesce(oc.succeeded_at, oc.started_at)) as operation_at
  from (values
    ('CREATE_WAREHOUSE_TRANSFER_CORRECTION'::text),
    ('POST_WAREHOUSE_TRANSFER_CORRECTION'::text),
    ('CREATE_STOCKTAKE_CORRECTION'::text),
    ('POST_STOCKTAKE_CORRECTION'::text)
  ) requested(operation_code)
  left join public.operation_commands oc on oc.operation_code = requested.operation_code
  group by requested.operation_code
),
correction_diagnostics as (
  select
    c.correction_no,
    c.correction_kind,
    c.status,
    c.operation_at,
    c.posted_at,
    r.transfer_completion_rpc_ready,
    r.transfer_completion_execute_granted,
    r.transfer_create_rpc_ready,
    r.transfer_create_execute_granted,
    r.transfer_post_rpc_ready,
    r.transfer_post_execute_granted,
    r.stocktake_completion_rpc_ready,
    r.stocktake_completion_execute_granted,
    r.stocktake_create_rpc_ready,
    r.stocktake_create_execute_granted,
    r.stocktake_post_rpc_ready,
    r.stocktake_post_execute_granted,
    r.inventory_effect_guard_ready,
    evidence.posting_count,
    evidence.ledger_entry_count,
    evidence.last_posting_pointer_count,
    evidence.balance_reconciliation_count,
    case
      when c.status <> 'POSTED' then 'NOT_POSTED_NO_INVENTORY_CHANGE_EXPECTED'
      when c.correction_kind = 'WAREHOUSE_TRANSFER'
        and evidence.ledger_entry_count = 2 and evidence.balance_reconciliation_count = 2
        and evidence.last_posting_pointer_count = 2 then 'OK_TWO_WAREHOUSE_MOVEMENTS'
      when c.correction_kind = 'STOCKTAKE'
        and evidence.ledger_entry_count = 1 and evidence.balance_reconciliation_count = 1
        and evidence.last_posting_pointer_count = 1 then 'OK_ONE_WAREHOUSE_MOVEMENT'
      when c.correction_kind = 'WAREHOUSE_TRANSFER'
        and evidence.ledger_entry_count = 2 and evidence.balance_reconciliation_count = 2 then 'OK_BALANCES_RECONCILE_AFTER_LATER_POSTINGS'
      when c.correction_kind = 'STOCKTAKE'
        and evidence.ledger_entry_count = 1 and evidence.balance_reconciliation_count = 1 then 'OK_BALANCES_RECONCILE_AFTER_LATER_POSTINGS'
      when c.correction_kind = 'WAREHOUSE_TRANSFER' and evidence.ledger_entry_count = 2 then 'CHECK_BALANCE_NOT_UPDATED'
      when c.correction_kind = 'STOCKTAKE' and evidence.ledger_entry_count = 1 then 'CHECK_BALANCE_NOT_UPDATED'
      else 'CHECK_MISSING_POSTING_OR_LEDGER'
    end as posting_check,
    evidence.inventory_evidence
  from recent_corrections c
  cross join readiness r
  left join lateral (
    select
      count(distinct p.id)::integer as posting_count,
      count(distinct le.id)::integer as ledger_entry_count,
      (count(distinct b.warehouse_id) filter (where b.last_posting_id = p.id))::integer as last_posting_pointer_count,
      (count(distinct le.warehouse_id) filter (
        where b.warehouse_id is not null
          and b.on_hand_quantity = ledger_totals.ledger_on_hand
      ))::integer as balance_reconciliation_count,
      jsonb_agg(jsonb_build_object(
        'warehouse', w.name,
        'warehouse_purpose', w.purpose,
        'item_code', i.item_code,
        'movement_kind', le.movement_kind,
        'quantity_delta', le.quantity_delta,
        'current_on_hand', b.on_hand_quantity,
        'ledger_on_hand_from_history', ledger_totals.ledger_on_hand,
        'last_posting_matches', b.last_posting_id = p.id,
        'balance_reconciles_to_ledger', b.warehouse_id is not null and b.on_hand_quantity = ledger_totals.ledger_on_hand
      ) order by le.line_no) filter (where le.id is not null) as inventory_evidence
    from public.correction_posting_sources cps
    left join public.inventory_postings p on p.id = cps.posting_id
    left join public.inventory_ledger_entries le on le.posting_id = p.id
    left join public.warehouses w on w.id = le.warehouse_id
    left join public.uniform_items i on i.id = le.item_id
    left join public.inventory_balances b on b.warehouse_id = le.warehouse_id and b.item_id = le.item_id
    left join lateral (
      select coalesce(sum(all_ledger.quantity_delta), 0) as ledger_on_hand
      from public.inventory_ledger_entries all_ledger
      where all_ledger.warehouse_id = le.warehouse_id
        and all_ledger.item_id = le.item_id
    ) ledger_totals on le.id is not null
    where cps.correction_note_id = c.id
  ) evidence on true
)
select
  'DATABASE_READINESS'::text as record_type,
  null::text as correction_no,
  null::text as correction_kind,
  null::text as status,
  null::timestamptz as operation_at,
  null::timestamptz as posted_at,
  r.transfer_completion_rpc_ready,
  r.transfer_completion_execute_granted,
  r.transfer_create_rpc_ready,
  r.transfer_create_execute_granted,
  r.transfer_post_rpc_ready,
  r.transfer_post_execute_granted,
  r.stocktake_completion_rpc_ready,
  r.stocktake_completion_execute_granted,
  r.stocktake_create_rpc_ready,
  r.stocktake_create_execute_granted,
  r.stocktake_post_rpc_ready,
  r.stocktake_post_execute_granted,
  r.inventory_effect_guard_ready,
  null::integer as posting_count,
  null::integer as ledger_entry_count,
  null::integer as last_posting_pointer_count,
  null::integer as balance_reconciliation_count,
  case
    when not r.transfer_create_rpc_ready or not r.transfer_create_execute_granted
      or not r.transfer_post_rpc_ready or not r.transfer_post_execute_granted
      or not r.stocktake_create_rpc_ready or not r.stocktake_create_execute_granted
      or not r.stocktake_post_rpc_ready or not r.stocktake_post_execute_granted then 'REQUIRED_CORRECTION_RPC_MISSING_OR_NOT_EXECUTABLE'
    when not r.inventory_effect_guard_ready then 'INVENTORY_EFFECT_GUARD_MISSING'
    when not r.transfer_completion_rpc_ready or not r.transfer_completion_execute_granted
      or not r.stocktake_completion_rpc_ready or not r.stocktake_completion_execute_granted then 'LEGACY_FALLBACK_AVAILABLE'
    else 'DATABASE_READY'
  end as posting_check,
  null::jsonb as inventory_evidence,
  null::text as operation_code,
  null::integer as operation_count,
  null::integer as succeeded_count,
  array_remove(array[
    case
      when not r.transfer_create_rpc_ready or not r.transfer_create_execute_granted
        or not r.transfer_post_rpc_ready or not r.transfer_post_execute_granted
        or not r.stocktake_create_rpc_ready or not r.stocktake_create_execute_granted
        or not r.stocktake_post_rpc_ready or not r.stocktake_post_execute_granted
        then 'REQUIRED_CORRECTION_RPC_MISSING_OR_NOT_EXECUTABLE'
    end,
    case
      when r.transfer_create_rpc_ready and r.transfer_create_execute_granted
        and r.transfer_post_rpc_ready and r.transfer_post_execute_granted
        and r.stocktake_create_rpc_ready and r.stocktake_create_execute_granted
        and r.stocktake_post_rpc_ready and r.stocktake_post_execute_granted
        and (not r.transfer_completion_rpc_ready or not r.transfer_completion_execute_granted
          or not r.stocktake_completion_rpc_ready or not r.stocktake_completion_execute_granted)
        then 'LEGACY_FALLBACK_AVAILABLE'
    end,
    case when not r.inventory_effect_guard_ready then 'INVENTORY_EFFECT_GUARD_MISSING' end,
    case
      when r.transfer_completion_rpc_ready and r.transfer_completion_execute_granted
        and r.stocktake_completion_rpc_ready and r.stocktake_completion_execute_granted
        and r.transfer_create_rpc_ready and r.transfer_create_execute_granted
        and r.transfer_post_rpc_ready and r.transfer_post_execute_granted
        and r.stocktake_create_rpc_ready and r.stocktake_create_execute_granted
        and r.stocktake_post_rpc_ready and r.stocktake_post_execute_granted
        and r.inventory_effect_guard_ready then 'DATABASE_READY'
    end
  ], null)::text[] as readiness_flags
from readiness r
union all
select
  'RECENT_CORRECTION'::text as record_type,
  d.correction_no::text,
  d.correction_kind::text,
  d.status::text,
  d.operation_at,
  d.posted_at,
  d.transfer_completion_rpc_ready,
  d.transfer_completion_execute_granted,
  d.transfer_create_rpc_ready,
  d.transfer_create_execute_granted,
  d.transfer_post_rpc_ready,
  d.transfer_post_execute_granted,
  d.stocktake_completion_rpc_ready,
  d.stocktake_completion_execute_granted,
  d.stocktake_create_rpc_ready,
  d.stocktake_create_execute_granted,
  d.stocktake_post_rpc_ready,
  d.stocktake_post_execute_granted,
  d.inventory_effect_guard_ready,
  d.posting_count,
  d.ledger_entry_count,
  d.last_posting_pointer_count,
  d.balance_reconciliation_count,
  d.posting_check,
  d.inventory_evidence,
  null::text as operation_code,
  null::integer as operation_count,
  null::integer as succeeded_count,
  null::text[] as readiness_flags
from correction_diagnostics d
union all
select
  'OPERATION_SUMMARY'::text as record_type,
  null::text as correction_no,
  null::text as correction_kind,
  null::text as status,
  s.operation_at,
  null::timestamptz as posted_at,
  r.transfer_completion_rpc_ready,
  r.transfer_completion_execute_granted,
  r.transfer_create_rpc_ready,
  r.transfer_create_execute_granted,
  r.transfer_post_rpc_ready,
  r.transfer_post_execute_granted,
  r.stocktake_completion_rpc_ready,
  r.stocktake_completion_execute_granted,
  r.stocktake_create_rpc_ready,
  r.stocktake_create_execute_granted,
  r.stocktake_post_rpc_ready,
  r.stocktake_post_execute_granted,
  r.inventory_effect_guard_ready,
  null::integer as posting_count,
  null::integer as ledger_entry_count,
  null::integer as last_posting_pointer_count,
  null::integer as balance_reconciliation_count,
  case
    when s.operation_count = 0 then 'NO_PERSISTED_RPC_COMMAND'
    when s.succeeded_count = s.operation_count then 'COMMANDS_SUCCEEDED'
    else 'COMMANDS_REQUIRE_REVIEW'
  end as posting_check,
  null::jsonb as inventory_evidence,
  s.operation_code,
  s.operation_count,
  s.succeeded_count,
  null::text[] as readiness_flags
from operation_summary s
cross join readiness r
order by record_type, operation_at desc nulls last, correction_no nulls first, operation_code nulls first;
