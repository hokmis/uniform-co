-- Production stocktake acceptance: invoke the normal one-step RPC, verify the
-- posted ledger/balance effect, compensate to the original quantity through
-- the same RPC, then roll back the entire QA transaction.
begin;
set transaction isolation level serializable;

do $$
declare
  actor_id uuid;
  matching_admins integer;
  run_key constant text := 'QA-STOCKTAKE-RUNTIME-ROLLBACK-V1';
begin
  select count(*)::integer into matching_admins
  from public.app_accounts a
  where a.login_name = 'admin'
    and a.is_active
    and a.auth_user_id is not null
    and exists (
      select 1 from public.user_roles r
      where r.account_id = a.id and r.role_code::text = 'SYSTEM_ADMIN'
    );
  if matching_admins <> 1 then
    raise exception 'Expected exactly one active bound SYSTEM_ADMIN QA actor';
  end if;
  if exists (
    select 1 from public.stocktakes s
    where s.stocktake_no in (run_key || '-VERIFY', run_key || '-RESTORE')
  ) or exists (
    select 1 from public.operation_commands c
    where c.idempotency_key like run_key || '-%'
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
  v_warehouse_id uuid;
  v_item_id uuid;
  run_key constant text := 'QA-STOCKTAKE-RUNTIME-ROLLBACK-V1';
  before_quantity bigint;
  combined_quantity bigint;
  active_reserved bigint;
  first_count bigint;
  restore_count bigint;
  first_no text;
  restore_no text;
  first_key text;
  restore_key text;
  first_result public.stocktakes;
  restore_result public.stocktakes;
  first_postings integer;
  first_ledger_rows integer;
  first_delta bigint;
  restore_postings integer;
  restore_ledger_rows integer;
  restore_delta bigint;
  after_first_quantity bigint;
  after_restore_quantity bigint;
begin
  first_no := run_key || '-VERIFY';
  restore_no := run_key || '-RESTORE';
  first_key := run_key || '-FIRST';
  restore_key := run_key || '-RESTORE';

  select w.id into strict v_warehouse_id
  from public.warehouses w
  where w.purpose = 'GENERAL' and w.is_active;

  select i.id into strict v_item_id
  from public.uniform_items i
  where i.item_code = 'UADCS01XS' and i.is_active;

  select b.on_hand_quantity into strict before_quantity
  from public.inventory_balances b
  where b.warehouse_id = v_warehouse_id and b.item_id = v_item_id;

  select coalesce(sum(b.on_hand_quantity), 0)::bigint into combined_quantity
  from public.inventory_balances b
  join public.warehouses w on w.id = b.warehouse_id
  where w.is_active and w.purpose in ('HR', 'GENERAL') and b.item_id = v_item_id;

  select coalesce(sum(r.quantity), 0)::bigint into active_reserved
  from public.inventory_reservations r
  where r.item_id = v_item_id and r.status = 'ACTIVE';

  if combined_quantity < active_reserved then
    raise exception 'QA item has insufficient stock coverage for active reservations';
  end if;

  first_count := before_quantity + 1;
  first_result := public.complete_stocktake(
    null,
    first_no,
    v_warehouse_id,
    'Bounded positive stocktake runtime verification',
    jsonb_build_array(jsonb_build_object(
      'itemId', v_item_id::text,
      'countedQuantity', first_count,
      'reason', 'QA positive one-step verification'
    )),
    first_key || '-CREATE', first_key || '-CREATE-FINGERPRINT',
    first_key || '-UPDATE', first_key || '-UPDATE-FINGERPRINT',
    first_key || '-POST', first_key || '-POST-FINGERPRINT'
  );

  if first_result.id is null or first_result.status <> 'POSTED' then
    raise exception 'One-step positive stocktake did not reach POSTED';
  end if;

  select b.on_hand_quantity into strict after_first_quantity
  from public.inventory_balances b
  where b.warehouse_id = v_warehouse_id and b.item_id = v_item_id;

  select count(distinct p.id)::integer, count(le.id)::integer,
         coalesce(sum(le.quantity_delta), 0)::bigint
    into first_postings, first_ledger_rows, first_delta
  from public.inventory_postings p
  left join public.inventory_ledger_entries le on le.posting_id = p.id
    and le.warehouse_id = v_warehouse_id and le.item_id = v_item_id
    and le.movement_kind = 'STOCKTAKE_ADJUSTMENT'
  where p.posting_kind = 'STOCKTAKE' and p.source_entity_id = first_result.id;

  if after_first_quantity <> before_quantity + 1
     or first_postings <> 1 or first_ledger_rows <> 1 or first_delta <> 1 then
    raise exception 'Positive stocktake did not update exactly one balance and ledger row';
  end if;

  restore_count := before_quantity;
  restore_result := public.complete_stocktake(
    null,
    restore_no,
    v_warehouse_id,
    'Compensating QA stocktake restores the original quantity',
    jsonb_build_array(jsonb_build_object(
      'itemId', v_item_id::text,
      'countedQuantity', restore_count,
      'reason', 'QA compensation to the original quantity'
    )),
    restore_key || '-CREATE', restore_key || '-CREATE-FINGERPRINT',
    restore_key || '-UPDATE', restore_key || '-UPDATE-FINGERPRINT',
    restore_key || '-POST', restore_key || '-POST-FINGERPRINT'
  );

  if restore_result.id is null or restore_result.status <> 'POSTED' then
    raise exception 'Compensating stocktake did not reach POSTED';
  end if;

  select b.on_hand_quantity into strict after_restore_quantity
  from public.inventory_balances b
  where b.warehouse_id = v_warehouse_id and b.item_id = v_item_id;

  select count(distinct p.id)::integer, count(le.id)::integer,
         coalesce(sum(le.quantity_delta), 0)::bigint
    into restore_postings, restore_ledger_rows, restore_delta
  from public.inventory_postings p
  left join public.inventory_ledger_entries le on le.posting_id = p.id
    and le.warehouse_id = v_warehouse_id and le.item_id = v_item_id
    and le.movement_kind = 'STOCKTAKE_ADJUSTMENT'
  where p.posting_kind = 'STOCKTAKE' and p.source_entity_id = restore_result.id;

  if after_restore_quantity <> before_quantity
     or restore_postings <> 1 or restore_ledger_rows <> 1 or restore_delta <> -1
     or first_delta + restore_delta <> 0 then
    raise exception 'Compensating stocktake did not restore the baseline quantity';
  end if;
end;
$$;

rollback;

select
  true as one_step_positive_stocktake_posted,
  true as ledger_and_balance_changed_together,
  true as compensating_stocktake_restored_original_quantity,
  not exists (
    select 1 from public.stocktakes s
    where s.stocktake_no in (
      'QA-STOCKTAKE-RUNTIME-ROLLBACK-V1-VERIFY',
      'QA-STOCKTAKE-RUNTIME-ROLLBACK-V1-RESTORE'
    )
  ) as no_qa_stocktake_documents,
  not exists (
    select 1 from public.inventory_postings p
    join public.stocktakes s on s.id = p.source_entity_id
    where s.stocktake_no in (
      'QA-STOCKTAKE-RUNTIME-ROLLBACK-V1-VERIFY',
      'QA-STOCKTAKE-RUNTIME-ROLLBACK-V1-RESTORE'
    )
  ) as no_qa_inventory_postings,
  not exists (
    select 1 from public.operation_commands c
    where c.idempotency_key like 'QA-STOCKTAKE-RUNTIME-ROLLBACK-V1-%'
  ) as no_qa_operation_commands,
  true as qa_transaction_rolled_back;
