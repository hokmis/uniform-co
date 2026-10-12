-- Bounded production acceptance against existing QA stocktake/shipment/replenishment only.
-- Normal authenticated RPC, no direct stock writes; entire transaction rolls back.
-- Missing/ambiguous actor or QA source fails closed. No user data is returned.
begin;
do $$
declare actor uuid;
begin
  select a.auth_user_id into strict actor
  from public.app_accounts a
  where a.login_name = 'admin' and a.is_active and a.auth_user_id is not null
    and exists (select 1 from public.user_roles r where r.account_id = a.id and r.role_code::text = 'SYSTEM_ADMIN');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', actor::text, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', actor::text, true);
end;
$$;
set local role authenticated;
do $$
declare
  source_id uuid;
  key text := 'QA-NEGATIVE-COUNT-' || gen_random_uuid()::text;
  rejected boolean := false;
  before_corrections bigint;
  before_ledger bigint;
  before_balances jsonb;
begin
  if auth.uid() is null then raise exception 'QA actor is missing'; end if;
  select l.id into strict source_id
  from public.stocktake_lines l
  join public.stocktakes s on s.id = l.stocktake_id
  join public.uniform_items i on i.id = l.item_id
  where s.stocktake_no = 'QA-COUNT-20261004-01' and s.status = 'POSTED'
    and i.item_code = 'UADCS01XS' and l.counted_quantity = 100;
  select count(*) into before_corrections from public.correction_notes;
  select count(*) into before_ledger from public.inventory_ledger_entries;
  select jsonb_agg(to_jsonb(b) order by b.warehouse_id, b.item_id) into before_balances from public.inventory_balances b;
  begin
    perform public.complete_stocktake_correction(key, source_id, -101, 'QA negative count check', '',
      key || '-CREATE', key || '-CREATE', key || '-COMPLETE', key || '-COMPLETE');
  exception when raise_exception then
    if sqlerrm = 'Effective counted quantity cannot be negative' then
      rejected := true;
    else
      raise exception 'Unexpected stocktake rejection stage; acceptance was not proven';
    end if;
  end;
  if not rejected then raise exception 'Negative effective count was unexpectedly accepted'; end if;
  if (select count(*) from public.correction_notes) <> before_corrections
    or (select count(*) from public.inventory_ledger_entries) <> before_ledger
    or (select jsonb_agg(to_jsonb(b) order by b.warehouse_id, b.item_id) from public.inventory_balances b) is distinct from before_balances then
    raise exception 'Rejected correction retained transactional evidence';
  end if;
end;
$$;
rollback;
-- Transfer limits use the same authenticated actor and transaction boundaries.
begin;
do $$
declare actor uuid;
begin
  select a.auth_user_id into strict actor from public.app_accounts a
  where a.login_name = 'admin' and a.is_active and a.auth_user_id is not null
    and exists (select 1 from public.user_roles r where r.account_id = a.id and r.role_code::text = 'SYSTEM_ADMIN');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', actor::text, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', actor::text, true);
end;
$$;
set local role authenticated;
do $$
declare
  qa_source_kind text;
  qa_document_no text;
  source_id uuid;
  delta bigint;
  key text;
  rejected boolean;
  before_corrections bigint;
  before_ledger bigint;
  before_balances jsonb;
begin
  if auth.uid() is null then raise exception 'QA actor is missing'; end if;
  select count(*) into before_corrections from public.correction_notes;
  select count(*) into before_ledger from public.inventory_ledger_entries;
  select jsonb_agg(to_jsonb(b) order by b.warehouse_id, b.item_id) into before_balances from public.inventory_balances b;
  for qa_source_kind, qa_document_no in select * from (values
    ('SHIPMENT', 'QA-SHIP-20261004-01'),
    ('REPLENISHMENT', 'REP-20261004052932')
  ) as sources(kind, document_no) loop
    select s.line_id into strict source_id from public.v_warehouse_transfer_correction_sources s
    where s.source_kind = qa_source_kind and s.parent_no = qa_document_no
      and s.item_code = 'UADCS01XS' and s.actual_quantity = 1 and s.requested_quantity = 1;
    foreach delta in array array[2::bigint, -2::bigint] loop
      rejected := false;
      key := 'QA-TRANSFER-LIMIT-' || gen_random_uuid()::text;
      begin
        perform public.complete_warehouse_transfer_correction(key, qa_source_kind, source_id, delta,
          'QA transfer limit check', '', key || '-CREATE', key || '-CREATE', key || '-COMPLETE', key || '-COMPLETE');
      exception when raise_exception then
        if sqlerrm = 'Effective transfer quantity is outside the source limits' then
          rejected := true;
        else
          raise exception 'Unexpected transfer rejection stage; acceptance was not proven';
        end if;
      end;
      if not rejected then raise exception 'Invalid effective transfer was unexpectedly accepted'; end if;
    end loop;
  end loop;
  if (select count(*) from public.correction_notes) <> before_corrections
    or (select count(*) from public.inventory_ledger_entries) <> before_ledger
    or (select jsonb_agg(to_jsonb(b) order by b.warehouse_id, b.item_id) from public.inventory_balances b) is distinct from before_balances then
    raise exception 'Rejected transfer correction retained transactional evidence';
  end if;
end;
$$;
rollback;
select true as negative_count_rejected, true as shipment_transfer_limits_rejected,
       true as replenishment_transfer_limits_rejected, true as correction_and_ledger_unchanged,
       true as balances_unchanged, true as transaction_rolled_back;
