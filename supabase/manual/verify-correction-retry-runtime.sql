-- Replay only existing, completed QA corrections. No credentials are returned.
-- Ordinary authenticated inventory-completion RPCs; everything rolls back.
begin;
do $$
declare actor uuid; account uuid; payload jsonb;
begin
  select a.auth_user_id, a.id into strict actor, account from public.app_accounts a
  where a.login_name = 'admin' and a.is_active and a.auth_user_id is not null
    and exists (select 1 from public.user_roles r where r.account_id = a.id and r.role_code::text = 'SYSTEM_ADMIN');
  select jsonb_agg(jsonb_build_object('id', c.id, 'kind', c.correction_kind,
    'key', oc.idempotency_key, 'fingerprint', oc.canonical_request_fingerprint)) into payload
  from public.correction_notes c join public.operation_commands oc
    on oc.result_entity_id = c.id and oc.result_entity_type = 'correction_notes'
    and oc.actor_account_id = account and oc.status = 'SUCCEEDED'
    and oc.operation_code = case when c.correction_kind = 'STOCKTAKE'
      then 'POST_STOCKTAKE_CORRECTION' else 'POST_WAREHOUSE_TRANSFER_CORRECTION' end
  where c.status = 'POSTED' and c.correction_no in
    ('QA-COUNT-RESTORE-20261004-01', 'QA-SHIP-RESTORE-20261004-01', 'QA-REP-RESTORE-20261004-01');
  if coalesce(jsonb_array_length(payload), 0) <> 3 then
    raise exception 'Expected exactly three completed QA command records';
  end if;
  perform set_config('app.qa_correction_replay', payload::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', actor::text, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', actor::text, true);
end;
$$;
set local role authenticated;
do $$
declare
  entry jsonb;
  result public.correction_notes;
  conflict_rejected boolean;
  before_corrections bigint;
  before_ledger bigint;
  before_balances jsonb;
begin
  if auth.uid() is null then raise exception 'QA actor is missing'; end if;
  select count(*) into before_corrections from public.correction_notes;
  select count(*) into before_ledger from public.inventory_ledger_entries;
  select jsonb_agg(to_jsonb(b) order by b.warehouse_id, b.item_id) into before_balances from public.inventory_balances b;
  for entry in select value from jsonb_array_elements(current_setting('app.qa_correction_replay')::jsonb) loop
    if entry->>'kind' = 'STOCKTAKE' then
      result := public.post_stocktake_correction((entry->>'id')::uuid, entry->>'key', entry->>'fingerprint');
    else
      result := public.post_warehouse_transfer_correction((entry->>'id')::uuid, entry->>'key', entry->>'fingerprint');
    end if;
    if result.id is distinct from (entry->>'id')::uuid or result.status <> 'POSTED' then
      raise exception 'Correction retry did not return the same completed record';
    end if;
    conflict_rejected := false;
    begin
      if entry->>'kind' = 'STOCKTAKE' then
        perform public.post_stocktake_correction((entry->>'id')::uuid, entry->>'key', (entry->>'fingerprint') || '-CHANGED');
      else
        perform public.post_warehouse_transfer_correction((entry->>'id')::uuid, entry->>'key', (entry->>'fingerprint') || '-CHANGED');
      end if;
    exception when serialization_failure then conflict_rejected := true;
    end;
    if not conflict_rejected then raise exception 'Changed retry payload was unexpectedly accepted'; end if;
  end loop;
  if (select count(*) from public.correction_notes) <> before_corrections
    or (select count(*) from public.inventory_ledger_entries) <> before_ledger
    or (select jsonb_agg(to_jsonb(b) order by b.warehouse_id, b.item_id) from public.inventory_balances b) is distinct from before_balances then
    raise exception 'Correction retry changed inventory or created duplicate evidence';
  end if;
end;
$$;
rollback;
select true as same_record_returned, true as changed_payload_rejected,
       true as correction_ledger_and_balances_unchanged, true as transaction_rolled_back;
