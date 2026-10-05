-- Fixed production acceptance: all fixtures and adjustments roll back.
begin;
set transaction isolation level serializable;
do $$
declare bound_user uuid;
begin
  select a.auth_user_id into strict bound_user from public.app_accounts a
    where a.login_name='admin' and a.is_active and a.auth_user_id is not null
      and exists(select 1 from public.user_roles r where r.account_id=a.id and r.role_code::text='SYSTEM_ADMIN');
  if exists(select 1 from public.operation_commands where idempotency_key like 'QA-ADJUSTMENT-ROLLBACK-V1-%') then
    raise exception 'QA identifiers already exist';
  end if;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',bound_user,'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',bound_user::text,true);
end $$;
insert into public.uniform_items(id,item_code,item_name,unit)
  values('b0feebaa-a169-4d42-9ba0-260d70a27f40','QA-ADJUSTMENT-ROLLBACK-V1','QA rollback-only fixture','件');
set local role authenticated;
do $$
declare
  warehouse uuid;
  item uuid;
  original bigint;
  current_quantity bigint;
  doc public.inventory_adjustments;
  replay public.inventory_adjustments;
  lines jsonb;
  source text;
  fixture constant uuid := 'b0feebaa-a169-4d42-9ba0-260d70a27f40';
  claims text;
begin
  select w.id into strict warehouse from public.warehouses w where w.is_active and w.purpose='GENERAL';
  select i.id into strict item from public.uniform_items i where i.item_code='UADCS01XS' and i.is_active;
  select b.on_hand_quantity into strict original from public.inventory_balances b where b.warehouse_id=warehouse and b.item_id=item;
  lines := jsonb_build_array(jsonb_build_object('item_id',item,'quantity_delta',3,'reason','QA rollback-only increase'));
  doc := public.complete_inventory_adjustment(warehouse,current_date,'QA rollback-only',lines,'QA-ADJUSTMENT-ROLLBACK-V1-PLUS');
  select b.on_hand_quantity into strict current_quantity from public.inventory_balances b where b.warehouse_id=warehouse and b.item_id=item;
  if current_quantity <> original+3 then raise exception 'Positive delta failed'; end if;
  if (select count(*) from public.inventory_ledger_entries l where l.posting_id=doc.posting_id and l.quantity_delta=3 and l.movement_kind='MANUAL_ADJUSTMENT') <> 1 then raise exception 'Ledger mismatch'; end if;
  select h.source_no into strict source from public.v_inventory_history h where h.posting_id=doc.posting_id;
  if source is distinct from doc.adjustment_no then raise exception 'History source mismatch'; end if;
  replay := public.complete_inventory_adjustment(warehouse,current_date,'QA rollback-only',lines,'QA-ADJUSTMENT-ROLLBACK-V1-PLUS');
  if replay.id <> doc.id then raise exception 'Replay duplicate'; end if;
  select b.on_hand_quantity into strict current_quantity from public.inventory_balances b where b.warehouse_id=warehouse and b.item_id=item;
  if current_quantity <> original+3 then raise exception 'Replay changed stock'; end if;
  begin
    perform public.complete_inventory_adjustment(warehouse,current_date,'different',lines,'QA-ADJUSTMENT-ROLLBACK-V1-PLUS');
    raise exception 'Changed payload accepted';
  exception when invalid_parameter_value then null; end;
  lines := jsonb_build_array(jsonb_build_object('item_id',item,'quantity_delta',-3,'reason','QA rollback-only decrease'));
  replay := public.complete_inventory_adjustment(warehouse,current_date,'QA rollback-only',lines,'QA-ADJUSTMENT-ROLLBACK-V1-MINUS');
  select b.on_hand_quantity into strict current_quantity from public.inventory_balances b where b.warehouse_id=warehouse and b.item_id=item;
  if current_quantity <> original then raise exception 'Negative delta failed'; end if;
  begin
    perform public.complete_inventory_adjustment(warehouse,current_date,'QA atomic failure',
      jsonb_build_array(jsonb_build_object('item_id',item,'quantity_delta',1,'reason','QA'),
        jsonb_build_object('item_id',fixture,'quantity_delta',-1,'reason','QA')),
      'QA-ADJUSTMENT-ROLLBACK-V1-ATOMIC');
    raise exception 'Negative inventory accepted';
  exception when check_violation then
    if sqlerrm <> 'ADJUSTMENT_INSUFFICIENT_STOCK' then raise; end if;
  end;
  select b.on_hand_quantity into strict current_quantity from public.inventory_balances b where b.warehouse_id=warehouse and b.item_id=item;
  if current_quantity <> original then raise exception 'Failed mixed adjustment changed inventory'; end if;
  claims := current_setting('request.jwt.claims');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',gen_random_uuid(),'role','authenticated')::text,true);
  perform set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
  begin
    perform public.complete_inventory_adjustment(warehouse,current_date,'QA unauthorized',lines,'QA-ADJUSTMENT-ROLLBACK-V1-UNAUTHORIZED');
    raise exception 'Unbound actor accepted';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claims',claims,true);
  perform set_config('request.jwt.claim.sub',(claims::jsonb->>'sub'),true);
  begin
    perform public.complete_inventory_adjustment(warehouse,current_date,'QA',jsonb_build_array(jsonb_build_object('item_id',item,'quantity_delta',0,'reason','QA')),'QA-ADJUSTMENT-ROLLBACK-V1-ZERO');
    raise exception 'Zero accepted';
  exception when invalid_parameter_value then null; end;
  begin
    update public.inventory_adjustments set note='tamper' where id=doc.id;
    raise exception 'Authenticated direct update allowed';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.inventory_adjustment_lines(adjustment_id,item_id,item_code_snapshot,item_name_snapshot,quantity_delta,quantity_before,quantity_after,reason)
      values(doc.id,item,'QA','QA',1,0,1,'QA');
    raise exception 'Authenticated direct insert allowed';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin
  if exists(select 1 from public.operation_commands c where c.idempotency_key in ('QA-ADJUSTMENT-ROLLBACK-V1-ATOMIC','QA-ADJUSTMENT-ROLLBACK-V1-ZERO','QA-ADJUSTMENT-ROLLBACK-V1-UNAUTHORIZED')) then
    raise exception 'Failed command persisted';
  end if;
end $$;
rollback;
select not exists(select 1 from public.operation_commands where idempotency_key like 'QA-ADJUSTMENT-ROLLBACK-V1-%') as no_qa_commands,
  not exists(select 1 from public.inventory_adjustments where note='QA rollback-only') as no_qa_documents,
  not exists(select 1 from public.inventory_postings where idempotency_key like 'ADJUSTMENT:QA-ADJUSTMENT-ROLLBACK-V1-%') as no_qa_postings,
  not exists(select 1 from public.uniform_items where item_code='QA-ADJUSTMENT-ROLLBACK-V1') as no_qa_items,
  true as qa_transaction_rolled_back;
