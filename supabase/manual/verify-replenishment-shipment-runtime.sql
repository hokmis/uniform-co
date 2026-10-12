-- Production runtime acceptance for a partial replenishment shipment.
-- Uses the normal authenticated submit/post RPCs, requires a valid short-ship
-- reason, verifies both warehouse balances and ledger rows, replays POST, and
-- rolls back the complete QA transaction. No business-table DML is issued
-- directly by this script.

begin;
set transaction isolation level serializable;

do $$
declare
  actor_id uuid;
  actor_count integer;
  run_key constant text := 'QA-REPLENISHMENT-SHIPMENT-ROLLBACK-V1';
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
    select 1 from public.replenishment_requests where request_no = run_key || '-REQUEST'
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
  run_key constant text := 'QA-REPLENISHMENT-SHIPMENT-ROLLBACK-V1';
  v_item_id uuid;
  v_general_warehouse_id uuid;
  v_hr_warehouse_id uuid;
  v_short_ship_reason text;
  request_row public.replenishment_requests;
  replay_row public.replenishment_requests;
  v_request_line_id uuid;
  transfer_lines jsonb;
  v_general_before bigint;
  v_general_after bigint;
  v_hr_before bigint;
  v_hr_after bigint;
  v_posting_count integer;
  v_ledger_count integer;
  v_general_out_count integer;
  v_hr_in_count integer;
  v_missing_reason_rejected boolean := false;
begin
  if auth.uid() is null then raise exception 'QA actor is missing'; end if;

  select id into strict v_general_warehouse_id
  from public.warehouses where purpose = 'GENERAL' and is_active;
  select id into strict v_hr_warehouse_id
  from public.warehouses where purpose = 'HR' and is_active;
  select id into strict v_item_id
  from public.uniform_items where item_code = 'UADCS01XS' and is_active;
  select code into strict v_short_ship_reason
  from public.transfer_short_ship_reasons where is_active
  order by code limit 1;
  select coalesce((
    select b.on_hand_quantity from public.inventory_balances b
    where b.warehouse_id = v_general_warehouse_id and b.item_id = v_item_id
  ), 0) into v_general_before;
  select coalesce((
    select b.on_hand_quantity from public.inventory_balances b
    where b.warehouse_id = v_hr_warehouse_id and b.item_id = v_item_id
  ), 0) into v_hr_before;
  if v_general_before < 2 then
    raise exception 'QA item needs at least two GENERAL units for the partial shipment check';
  end if;

  request_row := public.submit_replenishment_request_with_lines(
    null,
    run_key || '-REQUEST',
    'Rollback-only partial replenishment shipment verification',
    jsonb_build_array(jsonb_build_object('itemId', v_item_id::text, 'quantity', 2)),
    run_key || '-CREATE', run_key || '-CREATE-FP',
    run_key || '-UPDATE', run_key || '-UPDATE-FP',
    run_key || '-SUBMIT', run_key || '-SUBMIT-FP'
  );
  if request_row.id is null or request_row.status <> 'SUBMITTED' then
    raise exception 'Replenishment request was not submitted';
  end if;

  select line.id into strict v_request_line_id
  from public.replenishment_request_lines line
  where line.request_id = request_row.id and line.item_id = v_item_id;
  transfer_lines := jsonb_build_array(jsonb_build_object(
    'lineId', v_request_line_id::text,
    'actualTransferQuantity', 1,
    'shortShipReasonCode', null
  ));

  begin
    perform public.post_replenishment_request_with_lines(
      request_row.id,
      transfer_lines,
      run_key || '-NO-REASON',
      run_key || '-NO-REASON-FP'
    );
  exception when others then
    if position('A short-ship reason is required' in sqlerrm) = 1 then
      v_missing_reason_rejected := true;
    else
      raise;
    end if;
  end;
  if not v_missing_reason_rejected then
    raise exception 'Partial replenishment without a reason was not rejected';
  end if;
  if (select status from public.replenishment_requests where id = request_row.id) <> 'SUBMITTED'
     or exists (
       select 1 from public.replenishment_request_lines line
       where line.id = v_request_line_id
         and (line.actual_transfer_quantity is not null or line.short_ship_reason_code is not null)
     )
     or exists (
       select 1 from public.inventory_postings posting
       where posting.posting_kind = 'REPLENISHMENT'
         and posting.source_entity_id = request_row.id
     ) then
    raise exception 'Rejected short shipment changed the request or inventory';
  end if;

  transfer_lines := jsonb_build_array(jsonb_build_object(
    'lineId', v_request_line_id::text,
    'actualTransferQuantity', 1,
    'shortShipReasonCode', v_short_ship_reason
  ));
  request_row := public.post_replenishment_request_with_lines(
    request_row.id,
    transfer_lines,
    run_key || '-POST',
    run_key || '-POST-FP'
  );
  if request_row.id is null or request_row.status <> 'SHIPPED' then
    raise exception 'Partial replenishment did not complete';
  end if;

  select b.on_hand_quantity into strict v_general_after
  from public.inventory_balances b
  where b.warehouse_id = v_general_warehouse_id and b.item_id = v_item_id;
  select b.on_hand_quantity into strict v_hr_after
  from public.inventory_balances b
  where b.warehouse_id = v_hr_warehouse_id and b.item_id = v_item_id;
  select count(distinct posting.id)::integer, count(ledger.id)::integer,
         count(*) filter (where ledger.warehouse_id = v_general_warehouse_id
           and ledger.movement_kind = 'REPLENISHMENT_OUT'
           and ledger.quantity_delta = -1)::integer,
         count(*) filter (where ledger.warehouse_id = v_hr_warehouse_id
           and ledger.movement_kind = 'REPLENISHMENT_IN'
           and ledger.quantity_delta = 1)::integer
    into v_posting_count, v_ledger_count, v_general_out_count, v_hr_in_count
  from public.inventory_postings posting
  left join public.inventory_ledger_entries ledger on ledger.posting_id = posting.id
  where posting.posting_kind = 'REPLENISHMENT'
    and posting.source_entity_id = request_row.id;

  if v_general_after <> v_general_before - 1 or v_hr_after <> v_hr_before + 1
     or v_posting_count <> 1 or v_ledger_count <> 2
     or v_general_out_count <> 1 or v_hr_in_count <> 1
     or (select status from public.replenishment_requests where id = request_row.id) <> 'SHIPPED'
     or (select count(*) from public.replenishment_request_lines line
         where line.id = v_request_line_id
           and line.requested_quantity = 2
           and line.actual_transfer_quantity = 1
           and line.short_ship_reason_code = v_short_ship_reason
           and line.maximum_transfer_quantity_snapshot = 2) <> 1 then
    raise exception 'Replenishment short shipment, reason, balances or ledger did not complete together';
  end if;

  replay_row := public.post_replenishment_request_with_lines(
    request_row.id,
    transfer_lines,
    run_key || '-POST',
    run_key || '-POST-FP'
  );
  if replay_row.id <> request_row.id or replay_row.status <> 'SHIPPED'
     or (select count(*) from public.inventory_postings
         where posting_kind = 'REPLENISHMENT' and source_entity_id = request_row.id) <> 1
     or (select count(*) from public.inventory_ledger_entries ledger
         join public.inventory_postings posting on posting.id = ledger.posting_id
         where posting.posting_kind = 'REPLENISHMENT'
           and posting.source_entity_id = request_row.id) <> 2
     or (select on_hand_quantity from public.inventory_balances
         where warehouse_id = v_general_warehouse_id and item_id = v_item_id) <> v_general_after
     or (select on_hand_quantity from public.inventory_balances
         where warehouse_id = v_hr_warehouse_id and item_id = v_item_id) <> v_hr_after then
    raise exception 'Replenishment POST retry duplicated or changed inventory effects';
  end if;
end;
$$;

rollback;

select
  not exists (
    select 1 from public.replenishment_requests
    where request_no = 'QA-REPLENISHMENT-SHIPMENT-ROLLBACK-V1-REQUEST'
  ) as no_qa_replenishment_request,
  not exists (
    select 1 from public.operation_commands
    where idempotency_key like '%QA-REPLENISHMENT-SHIPMENT-ROLLBACK-V1%'
  ) as no_qa_operation_commands,
  true as short_reason_was_required,
  true as replenishment_balances_and_ledger_verified,
  true as same_payload_retry_did_not_duplicate_effects,
  true as qa_transaction_rolled_back;
