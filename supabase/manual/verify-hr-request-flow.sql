-- 人資請領流程正式資料庫唯讀驗收
-- 只包含 SELECT；不會新增、修改或刪除資料。

-- 1. 送出 RPC 與送出驗證 trigger 是否已套用 0094。
with definitions as (
  select
    pg_get_functiondef('public.submit_hr_request(uuid, text, text)'::regprocedure) as submit_definition,
    pg_get_functiondef('private.validate_hr_request_submission()'::regprocedure) as validation_definition
)
select
  md5(submit_definition) as submit_definition_md5,
  position('update public.hr_issue_lines as target_line' in submit_definition) > 0 as submit_0094_scope_fix,
  position('update public.hr_issue_lines l' in submit_definition) = 0 as submit_has_no_target_l,
  position('from public.hr_issue_lines source_line' in validation_definition) > 0 as validation_0094_scope_fix
from definitions;

-- 1b. 整套人資請領流程的公開 RPC 入口是否都存在。
with required(routine_name) as (
  values
    ('create_hr_request_draft'::name),
    ('update_hr_request_draft'::name),
    ('update_hr_request'::name),
    ('submit_hr_request'::name),
    ('submit_hr_request_with_lines'::name),
    ('cancel_hr_request'::name),
    ('create_warehouse_shipment_draft'::name),
    ('post_warehouse_shipment'::name),
    ('create_replenishment_draft'::name),
    ('submit_replenishment_request'::name),
    ('post_replenishment_request'::name),
    ('post_replenishment_request_with_lines'::name),
    ('cancel_replenishment_request'::name),
    ('create_return_note_draft'::name),
    ('post_return_note'::name),
    ('create_return_correction_draft'::name),
    ('post_return_correction'::name),
    ('create_hr_issue_correction_draft'::name),
    ('post_hr_issue_correction'::name)
)
select
  required.routine_name,
  exists (
    select 1
    from pg_catalog.pg_proc procedure_row
    join pg_catalog.pg_namespace namespace_row on namespace_row.oid = procedure_row.pronamespace
    where namespace_row.nspname = 'public'
      and procedure_row.proname = required.routine_name
  ) as routine_exists
from required
order by required.routine_name;

-- 1b-1. Atomic editor submission is ready only when the exact signature is
-- installed as SECURITY DEFINER and executable by authenticated sessions.
with target as (
  select to_regprocedure(
    'public.submit_hr_request_with_lines(uuid, text, date, text, jsonb, jsonb, text, text, text, text, text, text)'
  ) as function_oid
)
select
  function_oid is not null as atomic_submit_signature_exists,
  coalesce((
    select procedure_row.prosecdef
    from pg_catalog.pg_proc procedure_row
    where procedure_row.oid = target.function_oid
  ), false) as atomic_submit_is_security_definer,
  coalesce(has_function_privilege('authenticated', function_oid, 'EXECUTE'), false) as authenticated_can_execute
from target;

-- 1c. 會正式異動庫存的 POST RPC 是否都寫入 posting 與 append-only ledger。
with required(routine_name) as (
  values
    ('post_warehouse_shipment'::name),
    ('post_replenishment_request'::name),
    ('post_replenishment_request_with_lines'::name),
    ('post_return_note'::name),
    ('post_return_correction'::name),
    ('post_hr_issue_correction'::name)
), definitions as (
  select
    required.routine_name,
    coalesce(
      (
        select string_agg(pg_catalog.pg_get_functiondef(procedure_row.oid), E'\n')
        from pg_catalog.pg_proc procedure_row
        join pg_catalog.pg_namespace namespace_row on namespace_row.oid = procedure_row.pronamespace
        where namespace_row.nspname = 'public'
          and procedure_row.proname = required.routine_name
      ),
      ''
    ) || case when required.routine_name in ('post_replenishment_request', 'post_replenishment_request_with_lines') then coalesce(
      (
        select string_agg(pg_catalog.pg_get_functiondef(procedure_row.oid), E'\n')
        from pg_catalog.pg_proc procedure_row
        join pg_catalog.pg_namespace namespace_row on namespace_row.oid = procedure_row.pronamespace
        where namespace_row.nspname = 'private'
          and procedure_row.proname = 'post_replenishment_request_with_lines'
      ),
      ''
    ) else '' end as definition
  from required
)
select
  routine_name,
  position('insert into public.inventory_postings' in definition) > 0 as writes_inventory_posting,
  position('insert into public.inventory_ledger_entries' in definition) > 0 as writes_inventory_ledger
from definitions
order by routine_name;

-- 1d. The public replenishment POST entry point must acquire the item mutex
-- before delegating to the private implementation.  This keeps POST aligned
-- with submit/cancel and prevents a request-lock/item-lock inversion.
with definition as (
  select pg_get_functiondef(
    'public.post_replenishment_request_with_lines(uuid, jsonb, text, text)'::regprocedure
  ) as body
)
select
  position('insert into public.inventory_item_locks' in body) > 0 as locks_items_first,
  position('return private.post_replenishment_request_with_lines(' in body) > 0 as delegates_to_private_impl,
  position('insert into public.inventory_item_locks' in body)
    < position('return private.post_replenishment_request_with_lines(' in body) as lock_order_ok
from definition;

-- 2. 送出流程相關 trigger 是否存在。
select
  t.tgname as trigger_name,
  p.pronamespace::pg_catalog.regnamespace::text || '.' || p.proname as trigger_function
from pg_catalog.pg_trigger t
join pg_catalog.pg_class c on c.oid = t.tgrelid
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
join pg_catalog.pg_proc p on p.oid = t.tgfoid
where n.nspname = 'public'
  and c.relname = 'hr_requests'
  and t.tgname in (
    'hr_request_submission_guard',
    'hr_request_active_master_guard',
    'hr_request_cancel_draft_shipment_cleanup'
  )
  and not t.tgisinternal
order by t.tgname;

-- 3. 基本流程數量與倉庫設定。
select
  count(*) filter (where status = 'DRAFT') as draft_requests,
  count(*) filter (where status = 'SUBMITTED') as submitted_requests,
  count(*) filter (where status = 'INVENTORY_REVIEW_REQUIRED') as inventory_review_requests,
  count(*) filter (where status = 'SHIPPED') as shipped_requests,
  count(*) filter (where status = 'CANCELLED') as cancelled_requests,
  (select count(*) from public.inventory_reservations where status = 'ACTIVE') as active_reservations,
  (select count(*) from public.warehouses where is_active and purpose = 'HR') as active_hr_warehouses,
  (select count(*) from public.warehouses where is_active and purpose = 'GENERAL') as active_general_warehouses
from public.hr_requests;

-- 4. 任何非零結果都代表流程狀態需要處理。
select 'DRAFT_WITH_ACTIVE_RESERVATION' as check_name, count(*) as violation_count
from public.hr_requests r
where r.status = 'DRAFT'
  and exists (
    select 1 from public.inventory_reservations reservation_row
    where reservation_row.source_hr_request_id = r.id
      and reservation_row.status = 'ACTIVE'
  )
union all
select 'CANCELLED_OR_SHIPPED_WITH_ACTIVE_RESERVATION', count(*)
from public.hr_requests r
where r.status in ('CANCELLED', 'SHIPPED')
  and exists (
    select 1 from public.inventory_reservations reservation_row
    where reservation_row.source_hr_request_id = r.id
      and reservation_row.status = 'ACTIVE'
  )
union all
select 'ACTIVE_RESERVATION_WITHOUT_SUBMITTED_REQUEST', count(*)
from public.inventory_reservations reservation_row
join public.hr_requests r on r.id = reservation_row.source_hr_request_id
where reservation_row.status = 'ACTIVE'
  and r.status <> 'SUBMITTED'
union all
select 'DRAFT_SHIPMENT_WITHOUT_SUBMITTED_REQUEST', count(*)
from public.warehouse_shipments shipment
join public.hr_requests r on r.id = shipment.hr_request_id
where shipment.status = 'DRAFT'
  and r.status <> 'SUBMITTED'
union all
select 'SHIPPED_REQUEST_WITHOUT_POSTED_SHIPMENT', count(*)
from public.hr_requests r
where r.status = 'SHIPPED'
  and not exists (
    select 1 from public.warehouse_shipments shipment
    where shipment.hr_request_id = r.id
      and shipment.status = 'POSTED'
  )
union all
select 'POSTED_SHIPMENT_WITHOUT_SHIPPED_REQUEST', count(*)
from public.warehouse_shipments shipment
join public.hr_requests r on r.id = shipment.hr_request_id
where shipment.status = 'POSTED'
  and r.status <> 'SHIPPED'
union all
select 'POSTED_SHIPMENT_WITHOUT_INVENTORY_POSTING', count(*)
from public.warehouse_shipments shipment
where shipment.status = 'POSTED'
  and not exists (
    select 1 from public.inventory_postings posting
    where posting.source_entity_id = shipment.id
      and posting.posting_kind = 'WAREHOUSE_SHIPMENT'
  )
union all
select 'SHIPPED_REPLENISHMENT_WITHOUT_INVENTORY_POSTING', count(*)
from public.replenishment_requests request_row
where request_row.status = 'SHIPPED'
  and not exists (
    select 1
    from public.inventory_postings posting
    where posting.source_entity_id = request_row.id
      and posting.posting_kind = 'REPLENISHMENT'
  );
