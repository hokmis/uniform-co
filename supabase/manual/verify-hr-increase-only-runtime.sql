-- Rollback-only production end-to-end acceptance for a two-size increase-only HR request.
-- Exercises the authenticated submit/cancel RPCs, then proves stock and ledger stay unchanged.
-- All QA requests, reservations, audit events, and idempotency commands are rolled back.
begin isolation level serializable;

do $$
begin
  if exists (
    select 1 from public.hr_requests
    where request_no like 'QA-INCREASE-ONLY-ROLLBACK-20261004%'
  ) then
    raise exception 'Reserved QA request number already exists; no data was changed';
  end if;
  if exists (
    select 1 from public.operation_commands
    where idempotency_key like 'QA-INC-ROLLBACK-20261004-%'
  ) then
    raise exception 'Reserved QA idempotency namespace already exists; no data was changed';
  end if;
end;
$$;

do $$
declare
  actor uuid;
begin
  select a.auth_user_id into strict actor
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
    jsonb_build_object('sub', actor::text, 'role', 'authenticated')::text,
    true
  );
  perform set_config('request.jwt.claim.sub', actor::text, true);
end;
$$;

set local role authenticated;

do $$
declare
  item_xs uuid;
  item_m uuid;
  req public.hr_requests;
  request_no text := 'QA-INCREASE-ONLY-ROLLBACK-20261004';
  operation_key text := 'QA-INC-ROLLBACK-20261004';
  before_ledger bigint;
  before_balances jsonb;
  request_lines integer;
  issue_total bigint;
  increase_total bigint;
  active_reservations integer;
  released_reservations integer;
begin
  if auth.uid() is null then raise exception 'QA actor is missing'; end if;

  select i.id into strict item_xs
  from public.uniform_items i
  where i.item_code = 'UADCS01XS' and i.is_active;
  select i.id into strict item_m
  from public.uniform_items i
  where i.item_code = 'UADCS01M' and i.is_active;

  select count(*) into before_ledger
  from public.inventory_ledger_entries l
  where l.item_id in (item_xs, item_m);
  select jsonb_agg(to_jsonb(b) order by b.warehouse_id, b.item_id)
    into before_balances
  from public.inventory_balances b
  where b.item_id in (item_xs, item_m);

  req := public.submit_hr_request_with_lines(
    null,
    request_no,
    current_date + 14,
    'QA increase-only multi-size flow',
    '[]'::jsonb,
    jsonb_build_array(
      jsonb_build_object('itemId', item_xs, 'quantity', 1),
      jsonb_build_object('itemId', item_m, 'quantity', 1)
    ),
    operation_key || '-CREATE', operation_key || '-CREATE-FP',
    operation_key || '-UPDATE', operation_key || '-UPDATE-FP',
    operation_key || '-SUBMIT', operation_key || '-SUBMIT-FP'
  );
  if req.id is null or req.status <> 'SUBMITTED' then
    raise exception 'Increase-only request was not submitted';
  end if;

  select count(*)::integer,
         coalesce(sum(ri.issue_quantity), 0),
         coalesce(sum(ri.increase_quantity), 0)
    into request_lines, issue_total, increase_total
  from public.hr_request_items ri
  where ri.request_id = req.id;
  if request_lines <> 2 or issue_total <> 0 or increase_total <> 2 then
    raise exception 'Increase-only item details were not persisted as expected';
  end if;

  select count(*)::integer into active_reservations
  from public.inventory_reservations r
  where r.source_hr_request_id = req.id and r.status = 'ACTIVE';
  if active_reservations <> 2 then
    raise exception 'Increase-only reservations were not created for both items';
  end if;

  req := public.cancel_hr_request(
    req.id,
    'QA runtime acceptance cleanup',
    operation_key || '-CANCEL',
    operation_key || '-CANCEL-FP'
  );
  if req.status <> 'CANCELLED' then
    raise exception 'Increase-only QA request was not cancelled';
  end if;

  select count(*)::integer into active_reservations
  from public.inventory_reservations r
  where r.source_hr_request_id = req.id and r.status = 'ACTIVE';
  select count(*)::integer into released_reservations
  from public.inventory_reservations r
  where r.source_hr_request_id = req.id and r.status = 'RELEASED';
  if active_reservations <> 0 or released_reservations <> 2 then
    raise exception 'Cancellation did not release both increase-only reservations';
  end if;

  if (select count(*) from public.inventory_ledger_entries l
      where l.item_id in (item_xs, item_m)) <> before_ledger
    or (select jsonb_agg(to_jsonb(b) order by b.warehouse_id, b.item_id)
        from public.inventory_balances b
        where b.item_id in (item_xs, item_m)) is distinct from before_balances then
    raise exception 'Increase-only request changed stock or ledger';
  end if;
end;
$$;

rollback;

select true as increase_only_multi_item_request_submitted,
       true as both_reservations_created_and_released,
       true as balances_and_ledger_unchanged,
       not exists (
         select 1 from public.hr_requests
         where request_no = 'QA-INCREASE-ONLY-ROLLBACK-20261004'
       ) as qa_request_absent_after_rollback,
       not exists (
         select 1 from public.operation_commands
         where idempotency_key like 'QA-INC-ROLLBACK-20261004-%'
       ) as qa_commands_absent_after_rollback;
