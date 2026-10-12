-- Public workflow acceptance. Every test fixture and movement is rolled back.
begin;
set transaction isolation level serializable;
do $$ declare actor uuid; begin
  select a.auth_user_id into strict actor from public.app_accounts a where a.login_name='admin' and a.is_active
    and exists(select 1 from public.user_roles r where r.account_id=a.id and r.role_code::text='SYSTEM_ADMIN');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',actor::text,true);
  if exists(select 1 from public.uniform_items where item_code='QA-HR-EARLY-ISSUE-V1') then raise exception 'QA fixture already exists'; end if;
end $$;
insert into public.uniform_items(id,item_code,item_name,unit) values('c18b3cc5-752c-40b1-894b-890d4ccafc70','QA-HR-EARLY-ISSUE-V1','QA rollback-only','件');
insert into public.app_accounts(id,auth_user_id,display_name) values('ceb3902c-cac1-4e71-a1cb-24573ab8526b','d70d0a18-67eb-4ccc-8f54-5b427fe0ce81','QA-HR-EARLY-ISSUE-V1');
insert into public.user_roles(account_id,role_code) values('ceb3902c-cac1-4e71-a1cb-24573ab8526b','HR');
set local role authenticated;
do $$
declare
  hr uuid;
  general uuid;
  employee uuid;
  item constant uuid := 'c18b3cc5-752c-40b1-894b-890d4ccafc70';
  req public.hr_requests;
  replay public.hr_requests;
  shipment public.warehouse_shipments;
  shipment_replay public.warehouse_shipments;
  request_item uuid;
  original_issue uuid;
  claims text;
  qty bigint;
begin
  select id into strict hr from public.warehouses where purpose='HR' and is_active;
  select id into strict general from public.warehouses where purpose='GENERAL' and is_active;
  select e.id into strict employee from public.employees e join public.institutions i on i.id=e.institution_id
    join public.departments d on d.id=e.department_id where e.employment_status='ACTIVE' and i.is_active and d.is_active order by e.id limit 1;
  perform public.complete_inventory_adjustment(hr,current_date,'QA-HR-EARLY-ISSUE-V1',jsonb_build_array(jsonb_build_object('item_id',item,'quantity_delta',10,'reason','QA')),'QA-HR-EARLY-ISSUE-V1-HR');
  perform public.complete_inventory_adjustment(general,current_date,'QA-HR-EARLY-ISSUE-V1',jsonb_build_array(jsonb_build_object('item_id',item,'quantity_delta',20,'reason','QA')),'QA-HR-EARLY-ISSUE-V1-GENERAL');
  req := public.create_hr_request_draft('QA-HR-EARLY-ISSUE-V1',current_date,'QA',
    jsonb_build_array(jsonb_build_object('employeeId',employee,'itemId',item,'quantity',4)),
    jsonb_build_array(jsonb_build_object('itemId',item,'quantity',2)),'QA-HR-EARLY-ISSUE-V1-CREATE','QA-create');
  req := public.submit_hr_request(req.id,'QA-HR-EARLY-ISSUE-V1-SUBMIT','QA-submit');
  select on_hand_quantity into strict qty from public.inventory_balances where warehouse_id=hr and item_id=item;
  if qty <> 6 then raise exception 'Expected HR quantity 6 immediately after submit, got %',qty; end if;
  select on_hand_quantity into strict qty from public.inventory_balances where warehouse_id=general and item_id=item;
  if qty <> 20 then raise exception 'GENERAL changed before shipment'; end if;
  if (select count(*) from public.v_inventory_history h where h.source_entity_id=req.id and h.source_no=req.request_no
    and h.movement_kind='HR_SUBMISSION_ISSUE' and h.quantity_delta=-4)<>1 then raise exception 'Issue history source or delta missing'; end if;
  replay := public.submit_hr_request(req.id,'QA-HR-EARLY-ISSUE-V1-SUBMIT','QA-submit');
  if replay.id<>req.id or (select on_hand_quantity from public.inventory_balances where warehouse_id=hr and item_id=item)<>6 then raise exception 'Submit replay debited twice'; end if;
  if (select active_reserved_quantity from public.v_item_availability where item_id=item)<>2 then raise exception 'Already issued stock was reserved again'; end if;
  claims:=current_setting('request.jwt.claims');
  perform set_config('request.jwt.claims',jsonb_build_object('sub','d70d0a18-67eb-4ccc-8f54-5b427fe0ce81','role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub','d70d0a18-67eb-4ccc-8f54-5b427fe0ce81',true);
  begin
    perform public.cancel_hr_request(req.id,'QA other HR','QA-HR-EARLY-ISSUE-V1-OTHER-CANCEL','QA-other');
    raise exception 'Other HR cancelled source';
  exception when insufficient_privilege then null; end;
  begin
    perform public.return_hr_request_to_hr(req.id,req.row_version,'QA HR cannot return','QA-HR-EARLY-ISSUE-V1-HR-RETURN');
    raise exception 'HR used warehouse return';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claims',claims,true);perform set_config('request.jwt.claim.sub',claims::jsonb->>'sub',true);
  original_issue:=req.issue_posting_id;
  shipment:=public.create_warehouse_shipment_draft('QA-HR-EARLY-ISSUE-V1-DRAFT',req.id,'QA-HR-EARLY-ISSUE-V1-DRAFT','QA-draft');
  begin
    perform public.return_hr_request_to_hr(req.id,req.row_version-1,'QA stale','QA-HR-EARLY-ISSUE-V1-STALE');
    raise exception 'Stale return accepted';
  exception when serialization_failure then null; end;
  req := public.return_hr_request_to_hr(req.id,req.row_version,'QA correct employee quantities','QA-HR-EARLY-ISSUE-V1-RETURN');
  if req.status<>'DRAFT' or req.return_reason<>'QA correct employee quantities' then raise exception 'Return did not produce editable source'; end if;
  if exists(select 1 from public.warehouse_shipments s where s.hr_request_id=req.id) then raise exception 'Returned shipment draft was not deleted'; end if;
  if (select count(*) from public.hr_request_issue_reversals where original_posting_id=original_issue)<>1 then raise exception 'Reversal source evidence missing'; end if;
  begin
    update public.hr_requests set issue_posting_id=original_issue where id=req.id;
    raise exception 'Browser could forge posting pointer';
  exception when insufficient_privilege then null; end;
  if (select on_hand_quantity from public.inventory_balances where warehouse_id=hr and item_id=item)<>10
    or (select on_hand_quantity from public.inventory_balances where warehouse_id=general and item_id=item)<>20
    or (select active_reserved_quantity from public.v_item_availability where item_id=item)<>0 then raise exception 'Return balance or reservations wrong'; end if;
  replay := public.return_hr_request_to_hr(req.id,(select source_row_version from public.hr_request_returns where request_id=req.id),'QA correct employee quantities','QA-HR-EARLY-ISSUE-V1-RETURN');
  if replay.id<>req.id or (select on_hand_quantity from public.inventory_balances where warehouse_id=hr and item_id=item)<>10 then raise exception 'Return replay credited twice'; end if;
  req := public.update_hr_request_draft(req.id,current_date,'QA modified',
    jsonb_build_array(jsonb_build_object('employeeId',employee,'itemId',item,'quantity',3)),
    jsonb_build_array(jsonb_build_object('itemId',item,'quantity',1)),'QA-HR-EARLY-ISSUE-V1-EDIT','QA-edit');
  req := public.submit_hr_request(req.id,'QA-HR-EARLY-ISSUE-V1-RESUBMIT','QA-resubmit');
  if (select on_hand_quantity from public.inventory_balances where warehouse_id=hr and item_id=item)<>7 then raise exception 'Resubmit did not use modified issue quantity'; end if;
  select ri.id into strict request_item from public.hr_request_items ri where ri.request_id=req.id and ri.item_id=item;
  shipment := public.complete_hr_warehouse_shipment_with_lines(req.id,req.row_version,'QA-HR-EARLY-ISSUE-V1-SHIP',
    jsonb_build_array(jsonb_build_object('requestItemId',request_item,'actualTransferQuantity',4,'shortShipReasonCode',null)),
    'QA-HR-EARLY-ISSUE-V1-SHIP','QA-ship');
  if (select on_hand_quantity from public.inventory_balances where warehouse_id=hr and item_id=item)<>11
    or (select on_hand_quantity from public.inventory_balances where warehouse_id=general and item_id=item)<>16 then raise exception 'Shipment deducted issue again or duplicated increase'; end if;
  shipment_replay := public.complete_hr_warehouse_shipment_with_lines(req.id,req.row_version,'QA-HR-EARLY-ISSUE-V1-SHIP',
    jsonb_build_array(jsonb_build_object('requestItemId',request_item,'actualTransferQuantity',4,'shortShipReasonCode',null)),
    'QA-HR-EARLY-ISSUE-V1-SHIP','QA-ship');
  if shipment_replay.id<>shipment.id or (select on_hand_quantity from public.inventory_balances where warehouse_id=hr and item_id=item)<>11 then raise exception 'Shipment replay moved stock twice'; end if;
  begin
    perform public.return_hr_request_to_hr(req.id,(select row_version from public.hr_requests where id=req.id),'QA posted','QA-HR-EARLY-ISSUE-V1-POSTED');
    raise exception 'Posted shipment returned';
  exception when invalid_parameter_value then null; end;
  -- No combination of large GENERAL stock may make insufficient HR stock issuable.
  req := public.create_hr_request_draft('QA-HR-EARLY-ISSUE-V1-LOW',current_date,'QA',
    jsonb_build_array(jsonb_build_object('employeeId',employee,'itemId',item,'quantity',12)),
    '[]'::jsonb,'QA-HR-EARLY-ISSUE-V1-LOW-CREATE','QA-low');
  begin
    perform public.submit_hr_request(req.id,'QA-HR-EARLY-ISSUE-V1-LOW-SUBMIT','QA-low-submit');
    raise exception 'Insufficient HR issue accepted';
  exception when check_violation then
    if sqlerrm<>'HR_INSUFFICIENT_ISSUE_STOCK' then raise; end if;
  end;
  if (select on_hand_quantity from public.inventory_balances where warehouse_id=hr and item_id=item)<>11 then raise exception 'Rejected submit changed stock'; end if;
  req:=public.create_hr_request_draft('QA-HR-EARLY-ISSUE-V1-CANCEL',current_date,'QA',
    jsonb_build_array(jsonb_build_object('employeeId',employee,'itemId',item,'quantity',2)),
    '[]'::jsonb,'QA-HR-EARLY-ISSUE-V1-CANCEL-CREATE','QA-cancel-create');
  req:=public.submit_hr_request(req.id,'QA-HR-EARLY-ISSUE-V1-CANCEL-SUBMIT','QA-cancel-submit');
  if (select on_hand_quantity from public.inventory_balances where warehouse_id=hr and item_id=item)<>9 then raise exception 'Issue-only submission failed'; end if;
  req:=public.cancel_hr_request(req.id,'QA cancel','QA-HR-EARLY-ISSUE-V1-CANCEL','QA-cancel');
  replay:=public.cancel_hr_request(req.id,'QA cancel','QA-HR-EARLY-ISSUE-V1-CANCEL','QA-cancel');
  if req.status<>'CANCELLED' or replay.id<>req.id or (select on_hand_quantity from public.inventory_balances where warehouse_id=hr and item_id=item)<>11 then raise exception 'Cancellation failed to reverse once'; end if;
  req:=public.create_hr_request_draft('QA-HR-EARLY-ISSUE-V1-LEGACY',current_date,'QA legacy fixture',
    jsonb_build_array(jsonb_build_object('employeeId',employee,'itemId',item,'quantity',2)),
    jsonb_build_array(jsonb_build_object('itemId',item,'quantity',1)),'QA-HR-EARLY-ISSUE-V1-LEGACY-CREATE','QA-legacy-create');
end $$;
reset role;
-- Minimal pre-cutover pending source fixture, not a new-policy submit.
update public.hr_requests set status='SUBMITTED',inventory_policy='LEGACY',submitted_at=now(),submitted_by=created_by
  where request_no='QA-HR-EARLY-ISSUE-V1-LEGACY';
insert into public.inventory_reservations(source_hr_request_id,item_id,quantity)
  select id,'c18b3cc5-752c-40b1-894b-890d4ccafc70',3 from public.hr_requests where request_no='QA-HR-EARLY-ISSUE-V1-LEGACY';
set local role authenticated;
do $$
declare req public.hr_requests; shipment public.warehouse_shipments; line_id uuid; begin
  select * into strict req from public.hr_requests where request_no='QA-HR-EARLY-ISSUE-V1-LEGACY';
  select id into strict line_id from public.hr_request_items where request_id=req.id;
  shipment:=public.complete_hr_warehouse_shipment_with_lines(req.id,req.row_version,'QA-HR-EARLY-ISSUE-V1-LEGACY-SHIP',
    jsonb_build_array(jsonb_build_object('requestItemId',line_id,'actualTransferQuantity',3,'shortShipReasonCode',null)),
    'QA-HR-EARLY-ISSUE-V1-LEGACY-SHIP','QA-legacy-ship');
  if (select on_hand_quantity from public.inventory_balances b join public.warehouses w on w.id=b.warehouse_id where w.purpose='HR' and b.item_id='c18b3cc5-752c-40b1-894b-890d4ccafc70')<>12
    or (select on_hand_quantity from public.inventory_balances b join public.warehouses w on w.id=b.warehouse_id where w.purpose='GENERAL' and b.item_id='c18b3cc5-752c-40b1-894b-890d4ccafc70')<>13 then
    raise exception 'Legacy pending shipment behavior changed';
  end if;
end $$;
rollback;
select not exists(select 1 from public.uniform_items where item_code='QA-HR-EARLY-ISSUE-V1') as no_qa_items,
  not exists(select 1 from public.hr_requests where request_no like 'QA-HR-EARLY-ISSUE-V1%') as no_qa_requests,
  not exists(select 1 from public.operation_commands where idempotency_key like '%QA-HR-EARLY-ISSUE-V1%') as no_qa_commands,
  not exists(select 1 from public.app_accounts where id='ceb3902c-cac1-4e71-a1cb-24573ab8526b') as no_qa_actor,
  true as transaction_rolled_back;
