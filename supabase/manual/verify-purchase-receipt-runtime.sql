-- Rollback-only production acceptance for the one-step purchase receipt path.
-- The approved snapshots and one temporary supplier/item link are fixtures
-- inside this transaction. Receipt, inventory, ledger, audit and idempotency
-- effects are exercised through authenticated RPCs only. Never COMMIT.
begin isolation level serializable;

do $preflight$
begin
  if exists (
    select 1 from public.purchase_orders
    where po_no = 'QA-RCV-RUNTIME-20261005-PO'
  ) or exists (
    select 1 from public.purchase_receipts
    where receipt_no = 'QA-RCV-RUNTIME-20261005-GRN'
  ) or exists (
    select 1 from public.operation_commands
    where idempotency_key like 'QA-RCV-RUNTIME-20261005-%'
  ) or exists (
    select 1 from public.supplier_uniform_items
    where supplier_item_code = 'QA-RCV-RUNTIME-20261005-LINK'
  ) or exists (
    select 1 from public.seasonal_campaigns
    where campaign_no = 'QA-RCV-RUNTIME-20261005-CAMPAIGN'
  ) then
    raise exception 'Reserved purchase-receipt QA namespace already exists; no data was changed';
  end if;

  if to_regprocedure(
       'public.set_seasonal_procurement_line(uuid,uuid,bigint,text,text,text,text)'
     ) is null
     or to_regprocedure(
       'public.create_purchase_order(text,uuid,bigint,date,date,character,numeric,numeric,text,text)'
     ) is null
     or to_regprocedure(
       'public.complete_purchase_receipt(text,uuid,bigint,bigint,bigint,text,date,text,text,text,text)'
     ) is null then
    raise exception 'Required procurement or receipt RPC is missing; no data was changed';
  end if;

  if (select count(*) from public.warehouses
      where purpose = 'GENERAL' and is_active) <> 1 then
    raise exception 'Exactly one active GENERAL warehouse is required; no data was changed';
  end if;
end;
$preflight$;

do $actor$
declare
  v_actor_account_id uuid;
  v_actor_user_id uuid;
begin
  select account.id, account.auth_user_id
    into strict v_actor_account_id, v_actor_user_id
  from public.app_accounts account
  where account.login_name = 'admin'
    and account.is_active
    and account.auth_user_id is not null
    and exists (
      select 1 from public.user_roles role_row
      where role_row.account_id = account.id
        and role_row.role_code::text = 'SYSTEM_ADMIN'
    );

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_actor_user_id::text, 'role', 'authenticated')::text,
    true
  );
  perform set_config('request.jwt.claim.sub', v_actor_user_id::text, true);
  perform set_config('app.qa.purchase_receipt_actor', v_actor_account_id::text, true);
end;
$actor$;

-- Seed only the minimum approved snapshot required by the real procurement
-- and receipt RPCs. Every fixture below is erased by the final ROLLBACK.
do $fixtures$
declare
  v_actor_account_id uuid := current_setting('app.qa.purchase_receipt_actor')::uuid;
  v_fixture record;
  v_campaign_id uuid := gen_random_uuid();
  v_submission_id uuid := gen_random_uuid();
  v_approval_id uuid := gen_random_uuid();
  v_approval_line_id uuid := gen_random_uuid();
begin
  select item.id as item_id, item.item_code, item.item_name, item.size, item.unit,
         supplier.id as supplier_id
    into strict v_fixture
  from public.uniform_items item
  cross join public.suppliers supplier
  where item.is_active
    and item.item_code not like 'DEMO-%'
    and supplier.is_active
    and not exists (
      select 1 from public.supplier_uniform_items supplier_item
      where supplier_item.item_id = item.id
        and supplier_item.supplier_id = supplier.id
    )
  order by item.item_code, supplier.supplier_code
  limit 1;

  insert into public.supplier_uniform_items (
    supplier_id, item_id, minimum_order_quantity, supplier_item_code, is_active
  ) values (
    v_fixture.supplier_id, v_fixture.item_id, null,
    'QA-RCV-RUNTIME-20261005-LINK', true
  );

  insert into public.seasonal_campaigns (
    id, campaign_no, name, season, status, window_start, window_end,
    opens_at, closes_at, created_by, approved_at
  ) values (
    v_campaign_id,
    'QA-RCV-RUNTIME-20261005-CAMPAIGN',
    'Rollback-only receipt verification',
    'QA', 'APPROVED', current_date, current_date + 1,
    now() - interval '2 days', now() - interval '1 day',
    v_actor_account_id, now()
  );

  insert into public.seasonal_campaign_items (
    campaign_id, item_id, item_code_snapshot, item_name_snapshot, unit_snapshot
  ) values (
    v_campaign_id, v_fixture.item_id, v_fixture.item_code,
    v_fixture.item_name, v_fixture.unit
  );

  insert into public.seasonal_approval_submissions (
    id, campaign_id, revision, status, demand_snapshot_hash,
    submitted_by, reviewed_at, reviewed_by
  ) values (
    v_submission_id, v_campaign_id, 1, 'APPROVED',
    'QA-RCV-RUNTIME-20261005-SNAPSHOT',
    v_actor_account_id, now(), v_actor_account_id
  );

  insert into public.seasonal_approval_submission_lines (
    submission_id, item_id, demand_quantity_snapshot,
    item_code_snapshot, item_name_snapshot, size_snapshot, unit_snapshot
  ) values (
    v_submission_id, v_fixture.item_id, 3,
    v_fixture.item_code, v_fixture.item_name, v_fixture.size, v_fixture.unit
  );

  insert into public.seasonal_approvals (
    id, approval_no, campaign_id, submission_id,
    demand_snapshot_hash, approved_by
  ) values (
    v_approval_id, 'QA-RCV-RUNTIME-20261005-APPROVAL',
    v_campaign_id, v_submission_id,
    'QA-RCV-RUNTIME-20261005-SNAPSHOT', v_actor_account_id
  );

  insert into public.seasonal_approval_lines (
    id, approval_id, item_id, demand_quantity_snapshot, approved_quantity,
    item_code_snapshot, item_name_snapshot, size_snapshot, unit_snapshot
  ) values (
    v_approval_line_id, v_approval_id, v_fixture.item_id, 3, 3,
    v_fixture.item_code, v_fixture.item_name, v_fixture.size, v_fixture.unit
  );

  perform set_config('app.qa.purchase_receipt_item', v_fixture.item_id::text, true);
  perform set_config('app.qa.purchase_receipt_supplier', v_fixture.supplier_id::text, true);
  perform set_config('app.qa.purchase_receipt_approval_line', v_approval_line_id::text, true);
end;
$fixtures$;

set local role authenticated;

do $runtime$
declare
  v_item_id uuid := current_setting('app.qa.purchase_receipt_item')::uuid;
  v_supplier_id uuid := current_setting('app.qa.purchase_receipt_supplier')::uuid;
  v_approval_line_id uuid := current_setting('app.qa.purchase_receipt_approval_line')::uuid;
  v_procurement_row public.seasonal_procurement_lines;
  v_purchase_order_row public.purchase_orders;
  v_purchase_order_line_id uuid;
  v_receipt_row public.purchase_receipts;
  v_retry_receipt public.purchase_receipts;
  v_general_warehouse_id uuid;
  v_before_quantity bigint;
  v_after_quantity bigint;
  v_before_ledger_count bigint;
  v_after_ledger_count bigint;
  v_receipt_posting_count integer;
  v_receipt_ledger_count integer;
  v_receipt_ledger_delta bigint;
  v_purchase_receipt_inventory_delta_correct boolean;
  v_receipt_retry_did_not_duplicate_posting boolean;
begin
  if auth.uid() is null then raise exception 'QA actor is missing'; end if;

  select warehouse.id into strict v_general_warehouse_id
  from public.warehouses warehouse
  where warehouse.purpose = 'GENERAL' and warehouse.is_active;

  select coalesce(balance.on_hand_quantity, 0) into strict v_before_quantity
  from (select 1) seed
  left join public.inventory_balances balance
    on balance.item_id = v_item_id
   and balance.warehouse_id = v_general_warehouse_id;
  select count(*) into v_before_ledger_count
  from public.inventory_ledger_entries entry_row
  where entry_row.item_id = v_item_id
    and entry_row.warehouse_id = v_general_warehouse_id;

  v_procurement_row := public.set_seasonal_procurement_line(
    v_approval_line_id,
    v_supplier_id,
    3,
    null,
    'Rollback-only runtime fixture',
    'QA-RCV-RUNTIME-20261005-SET-PROCUREMENT',
    'QA-RCV-RUNTIME-20261005-SET-PROCUREMENT-FP'
  );
  if v_procurement_row.id is null or v_procurement_row.final_purchase_quantity <> 3 then
    raise exception 'Authenticated procurement RPC did not create the expected QA line';
  end if;

  v_purchase_order_row := public.create_purchase_order(
    'QA-RCV-RUNTIME-20261005-PO',
    v_procurement_row.id,
    3,
    current_date,
    current_date + 7,
    'TWD',
    null,
    null,
    'QA-RCV-RUNTIME-20261005-CREATE-PO',
    'QA-RCV-RUNTIME-20261005-CREATE-PO-FP'
  );
  if v_purchase_order_row.id is null or v_purchase_order_row.status <> 'ORDERED' then
    raise exception 'Authenticated purchase-order RPC did not create the expected QA order';
  end if;

  select order_line.id into strict v_purchase_order_line_id
  from public.purchase_order_lines order_line
  where order_line.purchase_order_id = v_purchase_order_row.id;

  v_receipt_row := public.complete_purchase_receipt(
    'QA-RCV-RUNTIME-20261005-GRN',
    v_purchase_order_line_id,
    3, 3, 0, null, current_date,
    'QA-RCV-RUNTIME-20261005-CREATE-RECEIPT',
    'QA-RCV-RUNTIME-20261005-CREATE-RECEIPT-FP',
    'QA-RCV-RUNTIME-20261005-POST-RECEIPT',
    'QA-RCV-RUNTIME-20261005-POST-RECEIPT-FP'
  );
  if v_receipt_row.id is null or v_receipt_row.status <> 'POSTED' then
    raise exception 'One-step receipt RPC did not return a POSTED receipt';
  end if;

  select coalesce(balance.on_hand_quantity, 0) into strict v_after_quantity
  from (select 1) seed
  left join public.inventory_balances balance
    on balance.item_id = v_item_id
   and balance.warehouse_id = v_general_warehouse_id;
  select count(*) into v_after_ledger_count
  from public.inventory_ledger_entries entry_row
  where entry_row.item_id = v_item_id
    and entry_row.warehouse_id = v_general_warehouse_id;
  select count(*)::integer, coalesce(sum(entry_row.quantity_delta), 0)::bigint
    into v_receipt_ledger_count, v_receipt_ledger_delta
  from public.inventory_postings posting
  join public.inventory_ledger_entries entry_row
    on entry_row.posting_id = posting.id
  where posting.posting_kind = 'RECEIPT'
    and posting.source_entity_id = v_receipt_row.id
    and entry_row.item_id = v_item_id
    and entry_row.warehouse_id = v_general_warehouse_id;
  select count(*)::integer into v_receipt_posting_count
  from public.inventory_postings posting
  where posting.posting_kind = 'RECEIPT'
    and posting.source_entity_id = v_receipt_row.id;

  v_purchase_receipt_inventory_delta_correct :=
    v_after_quantity = v_before_quantity + 3
    and v_after_ledger_count = v_before_ledger_count + 1
    and v_receipt_posting_count = 1
    and v_receipt_ledger_count = 1
    and v_receipt_ledger_delta = 3;
  if not v_purchase_receipt_inventory_delta_correct then
    raise exception 'Receipt inventory balance or ledger delta is incorrect';
  end if;

  select order_row.* into strict v_purchase_order_row
  from public.purchase_orders order_row
  where order_row.id = v_purchase_order_row.id;
  if v_purchase_order_row.status <> 'RECEIVED' then
    raise exception 'Fully accepted purchase order did not reach RECEIVED';
  end if;

  v_retry_receipt := public.complete_purchase_receipt(
    'QA-RCV-RUNTIME-20261005-GRN',
    v_purchase_order_line_id,
    3, 3, 0, null, current_date,
    'QA-RCV-RUNTIME-20261005-CREATE-RECEIPT',
    'QA-RCV-RUNTIME-20261005-CREATE-RECEIPT-FP',
    'QA-RCV-RUNTIME-20261005-POST-RECEIPT',
    'QA-RCV-RUNTIME-20261005-POST-RECEIPT-FP'
  );
  if v_retry_receipt.id <> v_receipt_row.id or v_retry_receipt.status <> 'POSTED' then
    raise exception 'Identical receipt retry did not return the original result';
  end if;

  select coalesce(balance.on_hand_quantity, 0) into strict v_after_quantity
  from (select 1) seed
  left join public.inventory_balances balance
    on balance.item_id = v_item_id
   and balance.warehouse_id = v_general_warehouse_id;
  select count(*) into v_after_ledger_count
  from public.inventory_ledger_entries entry_row
  where entry_row.item_id = v_item_id
    and entry_row.warehouse_id = v_general_warehouse_id;
  select count(*)::integer into v_receipt_posting_count
  from public.inventory_postings posting
  where posting.posting_kind = 'RECEIPT'
    and posting.source_entity_id = v_receipt_row.id;

  v_receipt_retry_did_not_duplicate_posting :=
    v_after_quantity = v_before_quantity + 3
    and v_after_ledger_count = v_before_ledger_count + 1
    and v_receipt_posting_count = 1;
  if not v_receipt_retry_did_not_duplicate_posting then
    raise exception 'Identical receipt retry duplicated stock or ledger posting';
  end if;
end;
$runtime$;

rollback;

select
  true as one_step_receipt_posted_and_updated_inventory,
  true as receipt_created_one_ledger_entry,
  true as identical_receipt_retry_did_not_duplicate_posting,
  not exists (
    select 1 from public.purchase_orders
    where po_no = 'QA-RCV-RUNTIME-20261005-PO'
  ) as qa_purchase_order_absent_after_rollback,
  not exists (
    select 1 from public.purchase_receipts
    where receipt_no = 'QA-RCV-RUNTIME-20261005-GRN'
  ) as qa_receipt_absent_after_rollback,
  not exists (
    select 1 from public.operation_commands
    where idempotency_key like 'QA-RCV-RUNTIME-20261005-%'
  ) as qa_commands_absent_after_rollback,
  not exists (
    select 1 from public.seasonal_campaigns
    where campaign_no = 'QA-RCV-RUNTIME-20261005-CAMPAIGN'
  ) as qa_approval_fixture_absent_after_rollback,
  not exists (
    select 1 from public.supplier_uniform_items
    where supplier_item_code = 'QA-RCV-RUNTIME-20261005-LINK'
  ) as qa_supplier_item_link_absent_after_rollback;
