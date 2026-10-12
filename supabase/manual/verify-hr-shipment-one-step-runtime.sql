-- Production runtime acceptance for a new HR request and one-step shipment.
-- Uses normal authenticated request/shipment RPCs, verifies both warehouse
-- movements, request/reservation state and idempotent replay, then rolls back.
-- No business-table DML is issued directly by this script.

begin;
set transaction isolation level serializable;

do $$
declare
  actor_id uuid;
  actor_count integer;
  run_key constant text := 'QA-HR-SHIPMENT-ONE-STEP-ROLLBACK-V1';
begin
  select count(*)::integer into actor_count
  from public.app_accounts a
  where a.login_name = 'admin'
    and a.is_active
    and a.auth_user_id is not null
    and exists (
      select 1 from public.user_roles r
      where r.account_id = a.id and r.role_code::text = 'SYSTEM_ADMIN'
    );
  if actor_count <> 1 then
    raise exception 'Expected exactly one active bound SYSTEM_ADMIN QA actor';
  end if;
  if exists (
    select 1 from public.hr_requests where request_no = run_key || '-REQUEST'
  ) or exists (
    select 1 from public.warehouse_shipments where shipment_no = run_key || '-SHIPMENT'
  ) or exists (
    select 1 from public.operation_commands where idempotency_key like '%' || run_key || '%'
  ) then
    raise exception 'Reserved QA runtime identifier already exists; no data was changed';
  end if;

  select a.auth_user_id into strict actor_id
  from public.app_accounts a
  where a.login_name = 'admin'
    and a.is_active
    and a.auth_user_id is not null
    and exists (
      select 1 from public.user_roles r
      where r.account_id = a.id and r.role_code::text = 'SYSTEM_ADMIN'
    );
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', actor_id::text, 'role', 'authenticated')::text,
    true
  );
  perform set_config('request.jwt.claim.sub', actor_id::text, true);
end;
$$;

set local role authenticated;

do $$
declare
  run_key constant text := 'QA-HR-SHIPMENT-ONE-STEP-ROLLBACK-V1';
  v_item_id uuid;
  request_row public.hr_requests;
  shipment_row public.warehouse_shipments;
  replay_row public.warehouse_shipments;
  request_item_id uuid;
  shipment_lines jsonb;
  v_general_warehouse_id uuid;
  v_hr_warehouse_id uuid;
  general_before bigint;
  general_after bigint;
  hr_before bigint;
  hr_after bigint;
  active_reserved bigint;
  posting_count integer;
  ledger_count integer;
  general_out_count integer;
  hr_in_count integer;
begin
  if auth.uid() is null then raise exception 'QA actor is missing'; end if;

  select id into strict v_general_warehouse_id
  from public.warehouses where purpose = 'GENERAL' and is_active;
  select id into strict v_hr_warehouse_id
  from public.warehouses where purpose = 'HR' and is_active;
  select id into strict v_item_id
  from public.uniform_items
  where item_code = 'UADCS01XS' and is_active;
  select on_hand_quantity into strict general_before
  from public.inventory_balances
  where warehouse_id = v_general_warehouse_id and item_id = v_item_id;
  select coalesce((
    select on_hand_quantity from public.inventory_balances
    where warehouse_id = v_hr_warehouse_id and item_id = v_item_id
  ), 0) into hr_before;
  select coalesce(sum(reservation.quantity), 0)::bigint into active_reserved
  from public.inventory_reservations reservation
  where reservation.item_id = v_item_id and reservation.status = 'ACTIVE';
  if general_before < 1 then raise exception 'QA item has insufficient GENERAL stock'; end if;
  if general_before + hr_before - active_reserved < 1 then
    raise exception 'QA item has insufficient unreserved stock coverage';
  end if;

  request_row := public.submit_hr_request_with_lines(
    null,
    run_key || '-REQUEST',
    current_date + 14,
    'Rollback-only one-step warehouse shipment verification',
    '[]'::jsonb,
    jsonb_build_array(jsonb_build_object('itemId', v_item_id::text, 'quantity', 1)),
    run_key || '-CREATE', run_key || '-CREATE-FP',
    run_key || '-UPDATE', run_key || '-UPDATE-FP',
    run_key || '-SUBMIT', run_key || '-SUBMIT-FP'
  );
  if request_row.id is null or request_row.status <> 'SUBMITTED' then
    raise exception 'QA increase-only HR request was not submitted';
  end if;

  select id into strict request_item_id
  from public.hr_request_items
  where request_id = request_row.id and item_id = v_item_id;
  shipment_lines := jsonb_build_array(jsonb_build_object(
    'requestItemId', request_item_id::text,
    'actualTransferQuantity', 1,
    'shortShipReasonCode', null
  ));

  shipment_row := public.complete_hr_warehouse_shipment_with_lines(
    request_row.id,
    request_row.row_version,
    run_key || '-SHIPMENT',
    shipment_lines,
    run_key || '-COMPLETE',
    run_key || '-COMPLETE-FP'
  );
  if shipment_row.id is null or shipment_row.status <> 'POSTED'
     or shipment_row.hr_request_id <> request_row.id then
    raise exception 'One-step HR shipment did not return the posted shipment';
  end if;

  select on_hand_quantity into strict general_after
  from public.inventory_balances
  where warehouse_id = v_general_warehouse_id and item_id = v_item_id;
  select on_hand_quantity into strict hr_after
  from public.inventory_balances
  where warehouse_id = v_hr_warehouse_id and item_id = v_item_id;
  select count(distinct posting.id)::integer, count(ledger.id)::integer,
         count(*) filter (where ledger.warehouse_id = v_general_warehouse_id
           and ledger.movement_kind = 'WAREHOUSE_SHIPMENT_OUT'
           and ledger.quantity_delta = -1)::integer,
         count(*) filter (where ledger.warehouse_id = v_hr_warehouse_id
           and ledger.movement_kind = 'HR_REPLENISH_IN'
           and ledger.quantity_delta = 1)::integer
    into posting_count, ledger_count, general_out_count, hr_in_count
  from public.inventory_postings posting
  left join public.inventory_ledger_entries ledger on ledger.posting_id = posting.id
  where posting.posting_kind = 'WAREHOUSE_SHIPMENT'
    and posting.source_entity_id = shipment_row.id;
  if general_after <> general_before - 1 or hr_after <> hr_before + 1
     or posting_count <> 1 or ledger_count <> 2
     or general_out_count <> 1 or hr_in_count <> 1
     or (select status from public.hr_requests where id = request_row.id) <> 'SHIPPED'
     or exists (select 1 from public.inventory_reservations
                where source_hr_request_id = request_row.id and status = 'ACTIVE') then
    raise exception 'One-step shipment did not update balances, ledger and request state together';
  end if;

  replay_row := public.complete_hr_warehouse_shipment_with_lines(
    request_row.id,
    request_row.row_version,
    run_key || '-SHIPMENT',
    shipment_lines,
    run_key || '-COMPLETE',
    run_key || '-COMPLETE-FP'
  );
  if replay_row.id <> shipment_row.id
     or (select on_hand_quantity from public.inventory_balances
         where warehouse_id = v_general_warehouse_id and item_id = v_item_id) <> general_after
     or (select on_hand_quantity from public.inventory_balances
         where warehouse_id = v_hr_warehouse_id and item_id = v_item_id) <> hr_after
     or (select count(*) from public.inventory_postings
         where posting_kind = 'WAREHOUSE_SHIPMENT' and source_entity_id = shipment_row.id) <> 1
     or (select count(*) from public.inventory_ledger_entries ledger
         join public.inventory_postings posting on posting.id = ledger.posting_id
         where posting.posting_kind = 'WAREHOUSE_SHIPMENT'
           and posting.source_entity_id = shipment_row.id) <> 2 then
    raise exception 'HR shipment replay duplicated or changed the operation';
  end if;
end;
$$;

rollback;

select
  not exists (
    select 1 from public.hr_requests
    where request_no = 'QA-HR-SHIPMENT-ONE-STEP-ROLLBACK-V1-REQUEST'
  ) as no_qa_hr_request,
  not exists (
    select 1 from public.warehouse_shipments
    where shipment_no = 'QA-HR-SHIPMENT-ONE-STEP-ROLLBACK-V1-SHIPMENT'
  ) as no_qa_shipment,
  not exists (
    select 1 from public.operation_commands
    where idempotency_key like '%QA-HR-SHIPMENT-ONE-STEP-ROLLBACK-V1%'
  ) as no_qa_operation_commands,
  true as one_step_shipment_balances_and_ledger_verified,
  true as same_payload_retry_did_not_duplicate_inventory_effects,
  true as qa_transaction_rolled_back;
