-- Production runtime acceptance for employee issue, shipment, return, and
-- their HR issue / return corrections. Uses normal authenticated one-step
-- RPCs, verifies balances and ledger rows, replays payloads, then rolls back.
-- No business-table DML is issued directly by this script.

begin;
set transaction isolation level serializable;

do $$
declare
  actor_id uuid;
  actor_count integer;
  run_key constant text := 'QA-HR-ISSUE-SHIPMENT-ROLLBACK-V1';
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
    select 1 from public.return_notes where return_no = run_key || '-RETURN'
  ) or exists (
    select 1 from public.correction_notes
    where correction_no in (run_key || '-RETURN-CORRECTION', run_key || '-ISSUE-CORRECTION')
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
  run_key constant text := 'QA-HR-ISSUE-SHIPMENT-ROLLBACK-V1';
  v_employee_id uuid;
  v_item_id uuid;
  request_row public.hr_requests;
  request_replay public.hr_requests;
  shipment_row public.warehouse_shipments;
  shipment_replay public.warehouse_shipments;
  return_row public.return_notes;
  return_replay public.return_notes;
  return_correction_row public.correction_notes;
  return_correction_replay public.correction_notes;
  issue_correction_row public.correction_notes;
  issue_correction_replay public.correction_notes;
  v_request_item_id uuid;
  v_issue_line_id uuid;
  v_return_line_id uuid;
  v_return_reason_code text;
  return_lines jsonb;
  shipment_lines jsonb;
  v_general_warehouse_id uuid;
  v_hr_warehouse_id uuid;
  v_general_before bigint;
  v_general_after bigint;
  v_hr_before bigint;
  v_hr_after bigint;
  v_hr_after_return bigint;
  v_hr_after_return_correction bigint;
  v_hr_after_issue_correction bigint;
  v_active_reserved bigint;
  v_issue_line_count integer;
  v_issue_detail_count integer;
  v_distribution_history_count integer;
  v_reservation_closed_count integer;
  v_posting_count integer;
  v_ledger_count integer;
  v_general_out_count integer;
  v_hr_transfer_in_count integer;
  v_return_posting_count integer;
  v_return_ledger_count integer;
  v_return_in_count integer;
  v_return_quantity_delta bigint;
  v_return_correction_posting_count integer;
  v_return_correction_ledger_count integer;
  v_return_correction_movement_count integer;
  v_return_correction_history_count integer;
  v_issue_correction_posting_count integer;
  v_issue_correction_ledger_count integer;
  v_issue_correction_movement_count integer;
  v_issue_correction_history_count integer;
begin
  if auth.uid() is null then raise exception 'QA actor is missing'; end if;

  select id into strict v_general_warehouse_id
  from public.warehouses where purpose = 'GENERAL' and is_active;
  select id into strict v_hr_warehouse_id
  from public.warehouses where purpose = 'HR' and is_active;
  select id into strict v_item_id
  from public.uniform_items where item_code = 'UADCS01XS' and is_active;
  select e.id into strict v_employee_id
  from public.employees e
  join public.institutions i on i.id = e.institution_id
  join public.departments d on d.id = e.department_id and d.institution_id = e.institution_id
  where e.employment_status = 'ACTIVE' and i.is_active and d.is_active
  order by e.employee_no
  limit 1;

  select coalesce((
    select b.on_hand_quantity from public.inventory_balances b
    where b.warehouse_id = v_general_warehouse_id and b.item_id = v_item_id
  ), 0) into v_general_before;
  select coalesce((
    select b.on_hand_quantity from public.inventory_balances b
    where b.warehouse_id = v_hr_warehouse_id and b.item_id = v_item_id
  ), 0) into v_hr_before;
  select coalesce(sum(reservation.quantity), 0)::bigint into v_active_reserved
  from public.inventory_reservations reservation
  where reservation.item_id = v_item_id and reservation.status = 'ACTIVE';
  if v_general_before < 1 then raise exception 'QA item has insufficient GENERAL stock'; end if;
  if v_hr_before < 1 then raise exception 'QA item has insufficient HR stock for submit-time issue'; end if;
  if v_general_before + v_hr_before - v_active_reserved < 1 then
    raise exception 'QA item has insufficient unreserved stock coverage';
  end if;

  request_row := public.submit_hr_request_with_lines(
    null,
    run_key || '-REQUEST',
    current_date + 14,
    'Rollback-only employee issue and one-step shipment verification',
    jsonb_build_array(jsonb_build_object(
      'employeeId', v_employee_id::text,
      'itemId', v_item_id::text,
      'quantity', 1
    )),
    '[]'::jsonb,
    run_key || '-CREATE', run_key || '-CREATE-FP',
    run_key || '-UPDATE', run_key || '-UPDATE-FP',
    run_key || '-SUBMIT', run_key || '-SUBMIT-FP'
  );
  if request_row.id is null or request_row.status <> 'SUBMITTED' then
    raise exception 'Employee issue HR request was not submitted';
  end if;
  if (select b.on_hand_quantity from public.inventory_balances b where b.warehouse_id=v_hr_warehouse_id and b.item_id=v_item_id) <> v_hr_before-1 then
    raise exception 'Employee issue was not debited on submission';
  end if;

  select ri.id into strict v_request_item_id
  from public.hr_request_items ri
  where ri.request_id = request_row.id and ri.item_id = v_item_id;
  shipment_lines := jsonb_build_array(jsonb_build_object(
    'requestItemId', v_request_item_id::text,
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
    raise exception 'One-step employee issue shipment did not return the posted shipment';
  end if;

  select b.on_hand_quantity into strict v_general_after
  from public.inventory_balances b
  where b.warehouse_id = v_general_warehouse_id and b.item_id = v_item_id;
  select b.on_hand_quantity into strict v_hr_after
  from public.inventory_balances b
  where b.warehouse_id = v_hr_warehouse_id and b.item_id = v_item_id;
  select count(*)::integer into v_issue_line_count
  from public.hr_issue_lines issue_line
  where issue_line.request_id = request_row.id
    and issue_line.employee_id = v_employee_id
    and issue_line.item_id = v_item_id
    and issue_line.quantity = 1
    and issue_line.employee_no_snapshot is not null
    and issue_line.employee_name_snapshot is not null
    and issue_line.item_code_snapshot is not null;
  select count(*)::integer into v_issue_detail_count
  from public.v_hr_request_history_detail detail
  where detail.request_id = request_row.id
    and detail.detail_kind = 'ISSUE'
    and detail.detail_id in (
      select issue_line.id from public.hr_issue_lines issue_line
      where issue_line.request_id = request_row.id
    )
    and detail.quantity = 1;
  select count(*)::integer into v_distribution_history_count
  from public.v_employee_distribution_history history
  where history.source_id = request_row.id
    and history.employee_id = v_employee_id
    and history.item_id = v_item_id
    and history.event_kind = 'HR_ISSUE'
    and history.quantity_delta = 1;
  select count(*)::integer into v_reservation_closed_count
  from public.inventory_reservations reservation
  where reservation.source_hr_request_id = request_row.id
    and reservation.item_id = v_item_id
    and reservation.quantity = 1
    and reservation.status = 'CLOSED';

  select count(distinct posting.id)::integer, count(ledger.id)::integer,
         count(*) filter (where ledger.warehouse_id = v_general_warehouse_id
           and ledger.movement_kind = 'WAREHOUSE_SHIPMENT_OUT'
           and ledger.quantity_delta = -1)::integer,
         count(*) filter (where ledger.warehouse_id = v_hr_warehouse_id
           and ledger.movement_kind = 'HR_REPLENISH_IN'
           and ledger.quantity_delta = 1)::integer
    into v_posting_count, v_ledger_count, v_general_out_count, v_hr_transfer_in_count
  from public.inventory_postings posting
  left join public.inventory_ledger_entries ledger on ledger.posting_id = posting.id
  where posting.posting_kind = 'WAREHOUSE_SHIPMENT'
    and posting.source_entity_id = shipment_row.id;

  if v_general_after <> v_general_before - 1 or v_hr_after <> v_hr_before
     or v_issue_line_count <> 1 or v_issue_detail_count <> 1
     or v_distribution_history_count <> 1 or v_reservation_closed_count <> 0
     or v_posting_count <> 1 or v_ledger_count <> 2
     or v_general_out_count <> 1 or v_hr_transfer_in_count <> 1
     or (select status from public.hr_requests where id = request_row.id) <> 'SHIPPED'
     or (select count(*) from public.warehouse_shipment_lines shipment_line
         where shipment_line.shipment_id = shipment_row.id
           and shipment_line.actual_transfer_quantity = 1) <> 1 then
    raise exception 'Employee issue, request history, balances or shipment ledger did not complete together';
  end if;

  select issue_line.id into strict v_issue_line_id
  from public.hr_issue_lines issue_line
  where issue_line.request_id = request_row.id
    and issue_line.employee_id = v_employee_id
    and issue_line.item_id = v_item_id
    and issue_line.quantity = 1;
  select reason.code into strict v_return_reason_code
  from public.return_reason_codes reason
  where reason.is_active
  order by reason.sort_order, reason.code
  limit 1;
  return_lines := jsonb_build_array(jsonb_build_object(
    'originalIssueLineId', v_issue_line_id::text,
    'quantity', 1
  ));

  return_row := public.complete_return_note(
    run_key || '-RETURN',
    request_row.id,
    current_date,
    v_return_reason_code,
    'Rollback-only return workflow verification',
    'Return follows the QA employee issue in the same transaction',
    return_lines,
    run_key || '-RETURN-CREATE', run_key || '-RETURN-CREATE-FP',
    run_key || '-RETURN-POST', run_key || '-RETURN-POST-FP'
  );
  if return_row.id is null or return_row.status <> 'POSTED'
     or return_row.original_hr_request_id <> request_row.id then
    raise exception 'One-step employee return did not return the posted note';
  end if;
  select line.id into strict v_return_line_id
  from public.return_lines line
  where line.return_note_id = return_row.id
    and line.original_issue_line_id = v_issue_line_id;

  select b.on_hand_quantity into strict v_hr_after_return
  from public.inventory_balances b
  where b.warehouse_id = v_hr_warehouse_id and b.item_id = v_item_id;
  select count(distinct posting.id)::integer, count(ledger.id)::integer,
         count(*) filter (where ledger.warehouse_id = v_hr_warehouse_id
           and ledger.movement_kind = 'RETURN_IN'
           and ledger.quantity_delta = 1)::integer,
         coalesce(sum(ledger.quantity_delta), 0)::bigint
    into v_return_posting_count, v_return_ledger_count,
         v_return_in_count, v_return_quantity_delta
  from public.inventory_postings posting
  left join public.inventory_ledger_entries ledger on ledger.posting_id = posting.id
  where posting.posting_kind = 'RETURN'
    and posting.source_entity_id = return_row.id;
  if v_hr_after_return <> v_hr_before + 1
     or v_general_after <> v_general_before - 1
     or v_return_posting_count <> 1 or v_return_ledger_count <> 1
     or v_return_in_count <> 1 or v_return_quantity_delta <> 1 then
    raise exception 'Employee return did not update HR balance and RETURN_IN ledger together';
  end if;

  return_correction_row := public.complete_return_correction(
    run_key || '-RETURN-CORRECTION', v_return_line_id, -1,
    'Rollback-only return correction verification',
    'Reverse the QA return while preserving its original document',
    run_key || '-RETURN-CORRECTION-CREATE', run_key || '-RETURN-CORRECTION-CREATE-FP',
    run_key || '-RETURN-CORRECTION-POST', run_key || '-RETURN-CORRECTION-POST-FP'
  );
  if return_correction_row.id is null or return_correction_row.status <> 'POSTED'
     or return_correction_row.correction_kind <> 'RETURN' then
    raise exception 'One-step return correction did not return the posted correction';
  end if;
  select b.on_hand_quantity into strict v_hr_after_return_correction
  from public.inventory_balances b
  where b.warehouse_id = v_hr_warehouse_id and b.item_id = v_item_id;
  select count(distinct posting.id)::integer, count(ledger.id)::integer,
         count(*) filter (where ledger.movement_kind = 'RETURN_CORRECTION'
           and ledger.warehouse_id = v_hr_warehouse_id
           and ledger.quantity_delta = -1)::integer
    into v_return_correction_posting_count, v_return_correction_ledger_count,
         v_return_correction_movement_count
  from public.correction_posting_sources source
  join public.inventory_postings posting on posting.id = source.posting_id
  left join public.inventory_ledger_entries ledger on ledger.posting_id = posting.id
  where source.correction_note_id = return_correction_row.id;
  select count(*)::integer into v_return_correction_history_count
  from public.v_employee_distribution_history history
  where history.source_id = return_correction_row.id
    and history.employee_id = v_employee_id
    and history.item_id = v_item_id
    and history.event_kind = 'RETURN_CORRECTION'
    and history.quantity_delta = 1;
  if v_hr_after_return_correction <> v_hr_before
     or v_return_correction_posting_count <> 1
     or v_return_correction_ledger_count <> 1
     or v_return_correction_movement_count <> 1
     or v_return_correction_history_count <> 1 then
    raise exception 'Return correction did not reverse HR balance and append matching ledger and employee-history rows';
  end if;
  return_correction_replay := public.complete_return_correction(
    run_key || '-RETURN-CORRECTION', v_return_line_id, -1,
    'Rollback-only return correction verification',
    'Reverse the QA return while preserving its original document',
    run_key || '-RETURN-CORRECTION-CREATE', run_key || '-RETURN-CORRECTION-CREATE-FP',
    run_key || '-RETURN-CORRECTION-POST', run_key || '-RETURN-CORRECTION-POST-FP'
  );
  if return_correction_replay.id <> return_correction_row.id
     or (select on_hand_quantity from public.inventory_balances
         where warehouse_id = v_hr_warehouse_id and item_id = v_item_id) <> v_hr_after_return_correction
     or (select count(*) from public.correction_posting_sources source
         join public.inventory_ledger_entries ledger on ledger.posting_id = source.posting_id
         where source.correction_note_id = return_correction_row.id) <> 1 then
    raise exception 'Return correction retry duplicated or changed its inventory effect';
  end if;

  issue_correction_row := public.complete_hr_issue_correction(
    run_key || '-ISSUE-CORRECTION', v_issue_line_id, -1,
    'Rollback-only HR issue correction verification',
    'Reverse the QA issue while preserving its original request and shipment',
    run_key || '-ISSUE-CORRECTION-CREATE', run_key || '-ISSUE-CORRECTION-CREATE-FP',
    run_key || '-ISSUE-CORRECTION-POST', run_key || '-ISSUE-CORRECTION-POST-FP'
  );
  if issue_correction_row.id is null or issue_correction_row.status <> 'POSTED'
     or issue_correction_row.correction_kind <> 'HR_ISSUE' then
    raise exception 'One-step HR issue correction did not return the posted correction';
  end if;
  select b.on_hand_quantity into strict v_hr_after_issue_correction
  from public.inventory_balances b
  where b.warehouse_id = v_hr_warehouse_id and b.item_id = v_item_id;
  select count(distinct posting.id)::integer, count(ledger.id)::integer,
         count(*) filter (where ledger.movement_kind = 'HR_ISSUE_CORRECTION'
           and ledger.warehouse_id = v_hr_warehouse_id
           and ledger.quantity_delta = 1)::integer
    into v_issue_correction_posting_count, v_issue_correction_ledger_count,
         v_issue_correction_movement_count
  from public.correction_posting_sources source
  join public.inventory_postings posting on posting.id = source.posting_id
  left join public.inventory_ledger_entries ledger on ledger.posting_id = posting.id
  where source.correction_note_id = issue_correction_row.id;
  select count(*)::integer into v_issue_correction_history_count
  from public.v_employee_distribution_history history
  where history.source_id = issue_correction_row.id
    and history.employee_id = v_employee_id
    and history.item_id = v_item_id
    and history.event_kind = 'HR_ISSUE_CORRECTION'
    and history.quantity_delta = -1;
  if v_hr_after_issue_correction <> v_hr_before + 1
     or v_issue_correction_posting_count <> 1
     or v_issue_correction_ledger_count <> 1
     or v_issue_correction_movement_count <> 1
     or v_issue_correction_history_count <> 1 then
    raise exception 'HR issue correction did not adjust HR balance and append matching ledger and employee-history rows';
  end if;
  issue_correction_replay := public.complete_hr_issue_correction(
    run_key || '-ISSUE-CORRECTION', v_issue_line_id, -1,
    'Rollback-only HR issue correction verification',
    'Reverse the QA issue while preserving its original request and shipment',
    run_key || '-ISSUE-CORRECTION-CREATE', run_key || '-ISSUE-CORRECTION-CREATE-FP',
    run_key || '-ISSUE-CORRECTION-POST', run_key || '-ISSUE-CORRECTION-POST-FP'
  );
  if issue_correction_replay.id <> issue_correction_row.id
     or (select on_hand_quantity from public.inventory_balances
         where warehouse_id = v_hr_warehouse_id and item_id = v_item_id) <> v_hr_after_issue_correction
     or (select count(*) from public.correction_posting_sources source
         join public.inventory_ledger_entries ledger on ledger.posting_id = source.posting_id
         where source.correction_note_id = issue_correction_row.id) <> 1 then
    raise exception 'HR issue correction retry duplicated or changed its inventory effect';
  end if;

  request_replay := public.submit_hr_request_with_lines(
    null,
    run_key || '-REQUEST',
    current_date + 14,
    'Rollback-only employee issue and one-step shipment verification',
    jsonb_build_array(jsonb_build_object(
      'employeeId', v_employee_id::text,
      'itemId', v_item_id::text,
      'quantity', 1
    )),
    '[]'::jsonb,
    run_key || '-CREATE', run_key || '-CREATE-FP',
    run_key || '-UPDATE', run_key || '-UPDATE-FP',
    run_key || '-SUBMIT', run_key || '-SUBMIT-FP'
  );
  shipment_replay := public.complete_hr_warehouse_shipment_with_lines(
    request_row.id,
    request_row.row_version,
    run_key || '-SHIPMENT',
    shipment_lines,
    run_key || '-COMPLETE',
    run_key || '-COMPLETE-FP'
  );
  return_replay := public.complete_return_note(
    run_key || '-RETURN',
    request_row.id,
    current_date,
    v_return_reason_code,
    'Rollback-only return workflow verification',
    'Return follows the QA employee issue in the same transaction',
    return_lines,
    run_key || '-RETURN-CREATE', run_key || '-RETURN-CREATE-FP',
    run_key || '-RETURN-POST', run_key || '-RETURN-POST-FP'
  );
  if request_replay.id <> request_row.id or request_replay.status <> 'SHIPPED'
     or shipment_replay.id <> shipment_row.id
     or return_replay.id <> return_row.id or return_replay.status <> 'POSTED'
     or (select count(*) from public.hr_issue_lines where request_id = request_row.id) <> 1
     or (select count(*) from public.inventory_postings
         where posting_kind = 'WAREHOUSE_SHIPMENT' and source_entity_id = shipment_row.id) <> 1
     or (select count(*) from public.inventory_ledger_entries ledger
         join public.inventory_postings posting on posting.id = ledger.posting_id
         where posting.posting_kind = 'WAREHOUSE_SHIPMENT'
           and posting.source_entity_id = shipment_row.id) <> 2
     or (select on_hand_quantity from public.inventory_balances
         where warehouse_id = v_general_warehouse_id and item_id = v_item_id) <> v_general_after
      or (select on_hand_quantity from public.inventory_balances
          where warehouse_id = v_hr_warehouse_id and item_id = v_item_id) <> v_hr_after_issue_correction then
     raise exception 'HR request or shipment retry duplicated or changed the operation';
   end if;
  if (select count(*) from public.return_notes
      where return_no = run_key || '-RETURN' and status = 'POSTED') <> 1
     or (select count(*) from public.inventory_postings
         where posting_kind = 'RETURN' and source_entity_id = return_row.id) <> 1
     or (select count(*) from public.inventory_ledger_entries ledger
         join public.inventory_postings posting on posting.id = ledger.posting_id
         where posting.posting_kind = 'RETURN'
           and posting.source_entity_id = return_row.id
           and ledger.movement_kind = 'RETURN_IN'
           and ledger.quantity_delta = 1) <> 1
     or (select on_hand_quantity from public.inventory_balances
         where warehouse_id = v_hr_warehouse_id and item_id = v_item_id) <> v_hr_after_issue_correction then
    raise exception 'Return retry duplicated or changed its posted inventory effect';
  end if;
  if (select count(*) from public.correction_notes
      where id in (return_correction_row.id, issue_correction_row.id)
        and status = 'POSTED') <> 2
     or (select count(*) from public.correction_posting_sources source
         join public.inventory_postings posting on posting.id = source.posting_id
         join public.inventory_ledger_entries ledger on ledger.posting_id = posting.id
         where source.correction_note_id in (return_correction_row.id, issue_correction_row.id)) <> 2
     or (select on_hand_quantity from public.inventory_balances
         where warehouse_id = v_hr_warehouse_id and item_id = v_item_id) <> v_hr_after_issue_correction then
    raise exception 'HR issue or return correction retry duplicated or changed its inventory effect';
  end if;
end;
$$;

rollback;

select
  not exists (
    select 1 from public.hr_requests
    where request_no = 'QA-HR-ISSUE-SHIPMENT-ROLLBACK-V1-REQUEST'
  ) as no_qa_hr_request,
  not exists (
    select 1 from public.warehouse_shipments
    where shipment_no = 'QA-HR-ISSUE-SHIPMENT-ROLLBACK-V1-SHIPMENT'
  ) as no_qa_shipment,
  not exists (
    select 1 from public.return_notes
    where return_no = 'QA-HR-ISSUE-SHIPMENT-ROLLBACK-V1-RETURN'
  ) as no_qa_return_note,
  not exists (
    select 1 from public.correction_notes
    where correction_no in (
      'QA-HR-ISSUE-SHIPMENT-ROLLBACK-V1-RETURN-CORRECTION',
      'QA-HR-ISSUE-SHIPMENT-ROLLBACK-V1-ISSUE-CORRECTION'
    )
  ) as no_qa_corrections,
  not exists (
    select 1 from public.inventory_postings posting
    join public.return_notes note on note.id = posting.source_entity_id
    where posting.posting_kind = 'RETURN'
      and note.return_no = 'QA-HR-ISSUE-SHIPMENT-ROLLBACK-V1-RETURN'
  ) as no_qa_return_posting,
  not exists (
    select 1 from public.operation_commands
    where idempotency_key like '%QA-HR-ISSUE-SHIPMENT-ROLLBACK-V1%'
  ) as no_qa_operation_commands,
  not exists (
    select 1 from public.v_employee_distribution_history
    where source_no in (
      'QA-HR-ISSUE-SHIPMENT-ROLLBACK-V1-REQUEST',
      'QA-HR-ISSUE-SHIPMENT-ROLLBACK-V1-RETURN-CORRECTION',
      'QA-HR-ISSUE-SHIPMENT-ROLLBACK-V1-ISSUE-CORRECTION'
    )
  ) as no_qa_distribution_history,
  true as employee_issue_shipment_return_and_correction_balances_and_ledger_verified,
  true as same_payload_return_retry_did_not_duplicate,
  true as same_payload_correction_retries_did_not_duplicate,
  true as request_shipment_and_return_retries_did_not_duplicate_effects,
  true as qa_transaction_rolled_back;
