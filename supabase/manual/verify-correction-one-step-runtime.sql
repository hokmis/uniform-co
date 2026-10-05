-- Production runtime acceptance for one-step stocktake and transfer corrections.
-- Calls ordinary authenticated completion RPCs, verifies real ledger and
-- balance effects plus idempotent replay, then rolls the entire transaction back.
-- No business-table DML is issued directly by this script.

begin;
set transaction isolation level serializable;

do $$
declare
  actor_id uuid;
  actor_count integer;
  run_key constant text := 'QA-CORRECTION-ONE-STEP-ROLLBACK-V1';
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
    select 1 from public.correction_notes c
    where c.correction_no in (run_key || '-STOCKTAKE', run_key || '-TRANSFER')
  ) or exists (
    select 1 from public.operation_commands c
    where c.idempotency_key like '%' || run_key || '%'
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
  run_key constant text := 'QA-CORRECTION-ONE-STEP-ROLLBACK-V1';
  stocktake_line_id uuid;
  stocktake_item_id uuid;
  stocktake_warehouse_id uuid;
  transfer_line_id uuid;
  transfer_item_id uuid;
  general_warehouse_id uuid;
  hr_warehouse_id uuid;
  source_count bigint;
  effective_source_count bigint;
  source_transfer bigint;
  requested_transfer bigint;
  effective_source_transfer bigint;
  stocktake_before bigint;
  stocktake_after bigint;
  general_before bigint;
  general_after bigint;
  hr_before bigint;
  hr_after bigint;
  correction_row public.correction_notes;
  replay_row public.correction_notes;
  posting_count integer;
  ledger_count integer;
  movement_count integer;
  general_out_count integer;
  hr_in_count integer;
begin
  if auth.uid() is null then raise exception 'QA actor is missing'; end if;

  select id into strict general_warehouse_id
  from public.warehouses where purpose = 'GENERAL' and is_active;
  select id into strict hr_warehouse_id
  from public.warehouses where purpose = 'HR' and is_active;

  select st.warehouse_id, sl.id, sl.item_id, sl.counted_quantity
    into strict stocktake_warehouse_id, stocktake_line_id, stocktake_item_id, source_count
  from public.stocktakes st
  join public.stocktake_lines sl on sl.stocktake_id = st.id
  join public.uniform_items i on i.id = sl.item_id
  where st.stocktake_no = 'QA-COUNT-20261004-01'
    and st.status = 'POSTED'
    and i.item_code = 'UADCS01XS';
  if stocktake_warehouse_id <> general_warehouse_id then
    raise exception 'QA stocktake source is not in the GENERAL warehouse';
  end if;
  select source_count + coalesce(sum(line.counted_quantity_delta), 0)
    into effective_source_count
  from public.stocktake_correction_lines line
  join public.correction_notes correction on correction.id = line.correction_note_id
  where line.original_stocktake_line_id = stocktake_line_id
    and correction.status = 'POSTED';
  select on_hand_quantity into strict stocktake_before
  from public.inventory_balances
  where warehouse_id = stocktake_warehouse_id and item_id = stocktake_item_id;
  if effective_source_count <> stocktake_before then
    raise exception 'QA stocktake fixture no longer matches the current balance';
  end if;

  select b.on_hand_quantity into strict general_before
  from public.inventory_balances b
  where b.warehouse_id = general_warehouse_id and b.item_id = stocktake_item_id;
  select b.on_hand_quantity into strict hr_before
  from public.inventory_balances b
  where b.warehouse_id = hr_warehouse_id and b.item_id = stocktake_item_id;

  correction_row := public.complete_stocktake_correction(
    run_key || '-STOCKTAKE', stocktake_line_id, 1,
    'Bounded one-step runtime verification', 'Rollback-only QA transaction',
    run_key || '-STK-CREATE', run_key || '-STK-CREATE-FP',
    run_key || '-STK-POST', run_key || '-STK-POST-FP'
  );
  if correction_row.status <> 'POSTED' then
    raise exception 'One-step stocktake correction did not reach POSTED';
  end if;
  select on_hand_quantity into strict stocktake_after
  from public.inventory_balances
  where warehouse_id = stocktake_warehouse_id and item_id = stocktake_item_id;
  select count(distinct posting.id)::integer, count(ledger.id)::integer,
         count(*) filter (where ledger.movement_kind = 'STOCKTAKE_CORRECTION'
           and ledger.warehouse_id = stocktake_warehouse_id
           and ledger.quantity_delta = 1)::integer
    into posting_count, ledger_count, movement_count
  from public.correction_posting_sources source
  join public.inventory_postings posting on posting.id = source.posting_id
  left join public.inventory_ledger_entries ledger on ledger.posting_id = posting.id
  where source.correction_note_id = correction_row.id;
  if stocktake_after <> stocktake_before + 1
     or posting_count <> 1 or ledger_count <> 1 or movement_count <> 1 then
    raise exception 'Stocktake correction did not update one balance and one ledger row together';
  end if;

  replay_row := public.complete_stocktake_correction(
    run_key || '-STOCKTAKE', stocktake_line_id, 1,
    'Bounded one-step runtime verification', 'Rollback-only QA transaction',
    run_key || '-STK-CREATE', run_key || '-STK-CREATE-FP',
    run_key || '-STK-POST', run_key || '-STK-POST-FP'
  );
  if replay_row.id <> correction_row.id
     or (select on_hand_quantity from public.inventory_balances
         where warehouse_id = stocktake_warehouse_id and item_id = stocktake_item_id) <> stocktake_after
     or (select count(*) from public.inventory_ledger_entries ledger
         join public.correction_posting_sources source on source.posting_id = ledger.posting_id
         where source.correction_note_id = correction_row.id) <> 1 then
    raise exception 'Stocktake correction replay duplicated or changed the operation';
  end if;

  select line.id, line.item_id, line.actual_transfer_quantity,
         line.requested_transfer_quantity_snapshot
    into strict transfer_line_id, transfer_item_id, source_transfer, requested_transfer
  from public.warehouse_shipments shipment
  join public.warehouse_shipment_lines line on line.shipment_id = shipment.id
  join public.uniform_items item on item.id = line.item_id
  where shipment.shipment_no = 'QA-SHIP-20261004-01'
    and shipment.status = 'POSTED'
    and item.item_code = 'UADCS01XS';
  select source_transfer + coalesce(sum(line.transfer_quantity_delta), 0)
    into effective_source_transfer
  from public.warehouse_transfer_correction_lines line
  join public.correction_notes correction on correction.id = line.correction_note_id
  where line.original_shipment_line_id = transfer_line_id
    and correction.status = 'POSTED';
  if effective_source_transfer < 0 or effective_source_transfer >= requested_transfer then
    raise exception 'QA shipment fixture has no valid positive correction headroom';
  end if;

  select b.on_hand_quantity into strict general_before
  from public.inventory_balances b
  where b.warehouse_id = general_warehouse_id and b.item_id = transfer_item_id;
  select b.on_hand_quantity into strict hr_before
  from public.inventory_balances b
  where b.warehouse_id = hr_warehouse_id and b.item_id = transfer_item_id;
  if general_before < 1 then raise exception 'QA transfer fixture has insufficient GENERAL stock'; end if;

  correction_row := public.complete_warehouse_transfer_correction(
    run_key || '-TRANSFER', 'SHIPMENT', transfer_line_id, 1,
    'Bounded one-step runtime verification', 'Rollback-only QA transaction',
    run_key || '-TRF-CREATE', run_key || '-TRF-CREATE-FP',
    run_key || '-TRF-POST', run_key || '-TRF-POST-FP'
  );
  if correction_row.status <> 'POSTED' then
    raise exception 'One-step transfer correction did not reach POSTED';
  end if;
  select b.on_hand_quantity into strict general_after
  from public.inventory_balances b
  where b.warehouse_id = general_warehouse_id and b.item_id = transfer_item_id;
  select b.on_hand_quantity into strict hr_after
  from public.inventory_balances b
  where b.warehouse_id = hr_warehouse_id and b.item_id = transfer_item_id;
  select count(ledger.id)::integer,
         count(*) filter (where ledger.warehouse_id = general_warehouse_id
           and ledger.movement_kind = 'WAREHOUSE_TRANSFER_CORRECTION_OUT'
           and ledger.quantity_delta = -1)::integer,
         count(*) filter (where ledger.warehouse_id = hr_warehouse_id
           and ledger.movement_kind = 'WAREHOUSE_TRANSFER_CORRECTION_IN'
           and ledger.quantity_delta = 1)::integer
    into ledger_count, general_out_count, hr_in_count
  from public.correction_posting_sources source
  join public.inventory_ledger_entries ledger on ledger.posting_id = source.posting_id
  where source.correction_note_id = correction_row.id;
  if general_after <> general_before - 1 or hr_after <> hr_before + 1
     or ledger_count <> 2 or general_out_count <> 1 or hr_in_count <> 1 then
    raise exception 'Transfer correction did not update both warehouse balances and ledger rows together';
  end if;

  replay_row := public.complete_warehouse_transfer_correction(
    run_key || '-TRANSFER', 'SHIPMENT', transfer_line_id, 1,
    'Bounded one-step runtime verification', 'Rollback-only QA transaction',
    run_key || '-TRF-CREATE', run_key || '-TRF-CREATE-FP',
    run_key || '-TRF-POST', run_key || '-TRF-POST-FP'
  );
  if replay_row.id <> correction_row.id
     or (select on_hand_quantity from public.inventory_balances
         where warehouse_id = general_warehouse_id and item_id = transfer_item_id) <> general_after
     or (select on_hand_quantity from public.inventory_balances
         where warehouse_id = hr_warehouse_id and item_id = transfer_item_id) <> hr_after
     or (select count(*) from public.inventory_ledger_entries ledger
         join public.correction_posting_sources source on source.posting_id = ledger.posting_id
         where source.correction_note_id = correction_row.id) <> 2 then
    raise exception 'Transfer correction replay duplicated or changed the operation';
  end if;
end;
$$;

rollback;

select
  not exists (
    select 1 from public.correction_notes
    where correction_no in (
      'QA-CORRECTION-ONE-STEP-ROLLBACK-V1-STOCKTAKE',
      'QA-CORRECTION-ONE-STEP-ROLLBACK-V1-TRANSFER'
    )
  ) as no_qa_corrections,
  not exists (
    select 1 from public.operation_commands
    where idempotency_key like '%QA-CORRECTION-ONE-STEP-ROLLBACK-V1%'
  ) as no_qa_operation_commands,
  true as one_step_stocktake_and_transfer_effects_verified,
  true as same_payload_retries_did_not_duplicate_inventory_effects,
  true as qa_transaction_rolled_back;
