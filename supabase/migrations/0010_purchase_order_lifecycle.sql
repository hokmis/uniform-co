-- Purchase order quantity changes, cancellation and short-close lifecycle.

alter table public.purchase_orders
  add column if not exists reopened_at timestamptz,
  add column if not exists reopened_by uuid references public.app_accounts(id),
  add column if not exists reopen_reason_kind text;

create table public.purchase_order_line_changes (
  id uuid primary key default gen_random_uuid(),
  purchase_order_line_id uuid not null references public.purchase_order_lines(id),
  old_quantity bigint not null check (old_quantity >= 0),
  new_quantity bigint not null check (new_quantity >= 0),
  reason text not null check (btrim(reason) <> ''),
  changed_at timestamptz not null default now(),
  changed_by uuid not null references public.app_accounts(id)
);

alter table public.purchase_order_line_changes enable row level security;
create policy purchase_order_line_changes_read on public.purchase_order_line_changes
  for select to authenticated using (private.has_role('HR') or private.has_role('PROCUREMENT') or private.has_role('WAREHOUSE'));
revoke all on table public.purchase_order_line_changes from public, anon, authenticated;
grant select on public.purchase_order_line_changes to authenticated;

create or replace function public.change_purchase_order_quantity(
  p_purchase_order_line_id uuid,
  p_new_quantity bigint,
  p_reason text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.purchase_orders
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  po_line_row public.purchase_order_lines;
  po_row public.purchase_orders;
  procurement_id uuid;
  current_limit bigint;
  allocated_quantity bigint;
  effective_accepted bigint;
  target_old_quantity bigint;
  target_status public.purchase_orders.status%type;
  related_po_line record;
  change_row public.purchase_order_line_changes;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('PROCUREMENT') then
    raise exception using errcode = '42501', message = 'PROCUREMENT role is required';
  end if;
  if p_new_quantity <= 0 or btrim(coalesce(p_reason, '')) = '' then raise exception 'PO quantity change is invalid'; end if;
  if btrim(coalesce(p_idempotency_key, '')) = '' or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'idempotency_key and request_fingerprint are required';
  end if;
  insert into public.operation_commands (
    operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id
  ) values (
    'CHANGE_PURCHASE_ORDER_QUANTITY', p_idempotency_key, p_request_fingerprint, current_account
  ) on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'CHANGE_PURCHASE_ORDER_QUANTITY' and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' then
      select * into po_row from public.purchase_orders where id = command_row.result_entity_id;
      return po_row;
    end if;
    raise exception using errcode = '40001', message = 'PO quantity change is already in progress or failed';
  end if;
  select * into po_line_row from public.purchase_order_lines where id = p_purchase_order_line_id;
  select * into po_row from public.purchase_orders where id = po_line_row.purchase_order_id for update;
  if po_row.id is null or po_row.status in ('CLOSED_SHORT', 'CANCELLED') then raise exception 'PO cannot be changed'; end if;
  select seasonal_procurement_line_id into procurement_id from public.purchase_order_lines where id = p_purchase_order_line_id;
  perform 1 from public.seasonal_procurement_lines where id = procurement_id for update;
  for related_po_line in
    select pol.id from public.purchase_order_lines pol
    where pol.purchase_order_id = po_row.id order by pol.id for update
  loop
    null;
  end loop;
  select * into po_line_row from public.purchase_order_lines where id = p_purchase_order_line_id for update;
  target_old_quantity := po_line_row.ordered_quantity;
  select coalesce(sum(prl.accepted_quantity), 0) into effective_accepted
  from public.purchase_receipt_lines prl
  join public.purchase_receipts pr on pr.id = prl.receipt_id
  where pr.purchase_order_id = po_row.id and pr.status = 'POSTED'
    and prl.purchase_order_line_id = p_purchase_order_line_id;
  select effective_accepted + coalesce(sum(cl.accepted_quantity_delta), 0) into effective_accepted
  from public.purchase_receipt_correction_lines cl
  join public.correction_notes cn on cn.id = cl.correction_note_id
  where cl.original_purchase_receipt_id in (select id from public.purchase_receipts where purchase_order_id = po_row.id)
    and cl.original_receipt_line_id in (
      select id from public.purchase_receipt_lines where purchase_order_line_id = p_purchase_order_line_id
    ) and cn.status = 'POSTED';
  effective_accepted := coalesce(effective_accepted, 0);
  if p_new_quantity < effective_accepted then raise exception 'PO quantity cannot be below effective accepted quantity'; end if;
  current_limit := coalesce((
    select c.new_purchase_limit_quantity from public.seasonal_procurement_line_changes c
    where c.procurement_line_id = procurement_id order by c.revision desc limit 1
  ), (select final_purchase_quantity from public.seasonal_procurement_lines where id = procurement_id));
  select coalesce(sum(case
    when po.status = 'CANCELLED' then 0
    when po.status = 'CLOSED_SHORT' then coalesce((
      select sum(prl.accepted_quantity) from public.purchase_receipt_lines prl
      join public.purchase_receipts pr on pr.id = prl.receipt_id
      where pr.purchase_order_id = po.id and pr.status = 'POSTED'
        and prl.purchase_order_line_id = pol.id
    ), 0)
    when pol.id = p_purchase_order_line_id then p_new_quantity
    else pol.ordered_quantity end), 0)
  into allocated_quantity
  from public.purchase_order_lines pol
  join public.purchase_orders po on po.id = pol.purchase_order_id
  where pol.seasonal_procurement_line_id = procurement_id;
  if allocated_quantity > current_limit then raise exception 'PO quantity exceeds current purchase limit'; end if;
  insert into public.purchase_order_line_changes (
    purchase_order_line_id, old_quantity, new_quantity, reason, changed_by
  ) values (
    p_purchase_order_line_id, target_old_quantity, p_new_quantity, left(btrim(p_reason), 500), current_account
  ) returning * into change_row;
  target_status := po_row.status;
  if po_row.status = 'RECEIVED' and p_new_quantity > effective_accepted then
    target_status := 'REOPENED';
    update public.purchase_orders
    set reopened_at = now(), reopened_by = current_account, reopen_reason_kind = 'ORDER_QUANTITY_INCREASE'
    where id = po_row.id;
  elsif p_new_quantity = effective_accepted and not exists (
    select 1 from public.purchase_order_lines pol
    where pol.purchase_order_id = po_row.id and pol.id <> p_purchase_order_line_id
      and pol.ordered_quantity > coalesce((select sum(prl.accepted_quantity) from public.purchase_receipt_lines prl
        join public.purchase_receipts pr on pr.id = prl.receipt_id
        where pr.purchase_order_id = po_row.id and pr.status = 'POSTED' and prl.purchase_order_line_id = pol.id), 0)
  ) then
    target_status := 'RECEIVED';
  end if;
  update public.purchase_order_lines set ordered_quantity = p_new_quantity where id = p_purchase_order_line_id;
  update public.purchase_orders set status = target_status where id = po_row.id returning * into po_row;
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'purchase_orders',
      result_entity_id = po_row.id, succeeded_at = now()
  where id = command_row.id;
  return po_row;
end;
$$;

create or replace function public.cancel_purchase_order(
  p_purchase_order_id uuid,
  p_cancel_reason text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.purchase_orders
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  po_row public.purchase_orders;
  procurement_id uuid;
  related_po_line record;
  result_row public.purchase_orders;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('PROCUREMENT') then
    raise exception using errcode = '42501', message = 'PROCUREMENT role is required';
  end if;
  if btrim(coalesce(p_cancel_reason, '')) = '' or btrim(coalesce(p_idempotency_key, '')) = ''
     or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'Cancellation reason and idempotency fields are required';
  end if;
  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('CANCEL_PURCHASE_ORDER', p_idempotency_key, p_request_fingerprint, current_account)
  on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'CANCEL_PURCHASE_ORDER' and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' then
      select * into result_row from public.purchase_orders where id = command_row.result_entity_id;
      return result_row;
    end if;
    raise exception using errcode = '40001', message = 'PO cancellation is already in progress or failed';
  end if;
  select * into po_row from public.purchase_orders where id = p_purchase_order_id for update;
  if po_row.status not in ('ORDERED', 'PARTIALLY_RECEIVED', 'REOPENED') then raise exception 'PO cannot be cancelled'; end if;
  if exists (
    select 1 from public.purchase_receipts pr where pr.purchase_order_id = p_purchase_order_id and pr.status = 'POSTED'
  ) then raise exception 'A PO with any POSTED receipt must be CLOSED_SHORT, not CANCELLED'; end if;
  select seasonal_procurement_line_id into procurement_id from public.purchase_order_lines where purchase_order_id = p_purchase_order_id order by id limit 1;
  perform 1 from public.seasonal_procurement_lines where id = procurement_id for update;
  for related_po_line in select pol.id from public.purchase_order_lines pol where pol.purchase_order_id = p_purchase_order_id order by pol.id for update loop null; end loop;
  update public.purchase_orders set status = 'CANCELLED', cancelled_at = now(), cancelled_by = current_account,
    cancel_reason = left(btrim(p_cancel_reason), 500) where id = p_purchase_order_id returning * into result_row;
  update public.operation_commands set status = 'SUCCEEDED', result_entity_type = 'purchase_orders', result_entity_id = p_purchase_order_id, succeeded_at = now() where id = command_row.id;
  return result_row;
end;
$$;

create or replace function public.close_purchase_order_short(
  p_purchase_order_id uuid,
  p_close_reason text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.purchase_orders
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  po_row public.purchase_orders;
  procurement_id uuid;
  related_po_line record;
  result_row public.purchase_orders;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('PROCUREMENT') then
    raise exception using errcode = '42501', message = 'PROCUREMENT role is required';
  end if;
  if btrim(coalesce(p_close_reason, '')) = '' or btrim(coalesce(p_idempotency_key, '')) = ''
     or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'Close reason and idempotency fields are required';
  end if;
  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('CLOSE_PURCHASE_ORDER_SHORT', p_idempotency_key, p_request_fingerprint, current_account)
  on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'CLOSE_PURCHASE_ORDER_SHORT' and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' then
      select * into result_row from public.purchase_orders where id = command_row.result_entity_id;
      return result_row;
    end if;
    raise exception using errcode = '40001', message = 'PO short close is already in progress or failed';
  end if;
  select * into po_row from public.purchase_orders where id = p_purchase_order_id for update;
  if po_row.status not in ('ORDERED', 'PARTIALLY_RECEIVED', 'REOPENED') then raise exception 'PO cannot be short-closed'; end if;
  if not exists (
    select 1 from public.purchase_receipts pr where pr.purchase_order_id = p_purchase_order_id and pr.status = 'POSTED'
  ) then raise exception 'CLOSED_SHORT requires at least one POSTED receipt'; end if;
  select seasonal_procurement_line_id into procurement_id from public.purchase_order_lines where purchase_order_id = p_purchase_order_id order by id limit 1;
  perform 1 from public.seasonal_procurement_lines where id = procurement_id for update;
  for related_po_line in select pol.id from public.purchase_order_lines pol where pol.purchase_order_id = p_purchase_order_id order by pol.id for update loop null; end loop;
  update public.purchase_orders set status = 'CLOSED_SHORT', closed_at = now(), closed_by = current_account,
    close_reason = left(btrim(p_close_reason), 500) where id = p_purchase_order_id returning * into result_row;
  update public.operation_commands set status = 'SUCCEEDED', result_entity_type = 'purchase_orders', result_entity_id = p_purchase_order_id, succeeded_at = now() where id = command_row.id;
  return result_row;
end;
$$;

revoke all on function public.change_purchase_order_quantity(uuid, bigint, text, text, text) from public, anon;
revoke all on function public.cancel_purchase_order(uuid, text, text, text) from public, anon;
revoke all on function public.close_purchase_order_short(uuid, text, text, text) from public, anon;
grant execute on function public.change_purchase_order_quantity(uuid, bigint, text, text, text) to authenticated;
grant execute on function public.cancel_purchase_order(uuid, text, text, text) to authenticated;
grant execute on function public.close_purchase_order_short(uuid, text, text, text) to authenticated;
