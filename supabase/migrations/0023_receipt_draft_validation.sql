-- Receipt drafts may be saved before physical inspection is complete.
alter table public.purchase_receipt_lines
  drop constraint if exists purchase_receipt_lines_delivered_quantity_check,
  drop constraint if exists purchase_receipt_lines_check,
  drop constraint if exists purchase_receipt_lines_check1;

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select c.conname
    from pg_catalog.pg_constraint c
    join pg_catalog.pg_class t on t.oid = c.conrelid
    join pg_catalog.pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'purchase_receipt_lines'
      and c.contype = 'c'
      and (
        pg_catalog.pg_get_constraintdef(c.oid) like '%delivered_quantity > 0%'
        or pg_catalog.pg_get_constraintdef(c.oid) like '%accepted_quantity + rejected_quantity = delivered_quantity%'
        or pg_catalog.pg_get_constraintdef(c.oid) like '%rejected_quantity = 0 or%'
      )
  loop
    execute format('alter table public.purchase_receipt_lines drop constraint %I', constraint_name);
  end loop;
end;
$$;

alter table public.purchase_receipt_lines
  add constraint purchase_receipt_lines_nonnegative_check
    check (delivered_quantity >= 0 and accepted_quantity >= 0 and rejected_quantity >= 0);

create or replace function public.create_purchase_receipt_draft(
  p_receipt_no text,
  p_purchase_order_line_id uuid,
  p_delivered_quantity bigint,
  p_accepted_quantity bigint,
  p_rejected_quantity bigint,
  p_rejection_reason text,
  p_received_on date,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.purchase_receipts
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  po_line_row public.purchase_order_lines;
  po_row public.purchase_orders;
  receipt_row public.purchase_receipts;
  related_po_line record;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('WAREHOUSE') then
    raise exception using errcode = '42501', message = 'WAREHOUSE role is required';
  end if;
  if btrim(coalesce(p_receipt_no, '')) = '' or p_delivered_quantity < 0
     or p_accepted_quantity < 0 or p_rejected_quantity < 0 then
    raise exception 'Receipt draft quantities are invalid';
  end if;
  if btrim(coalesce(p_idempotency_key, '')) = '' or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'idempotency_key and request_fingerprint are required';
  end if;
  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('CREATE_PURCHASE_RECEIPT_DRAFT', p_idempotency_key, p_request_fingerprint, current_account)
  on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'CREATE_PURCHASE_RECEIPT_DRAFT' and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' then
      select * into receipt_row from public.purchase_receipts where id = command_row.result_entity_id;
      return receipt_row;
    end if;
    raise exception using errcode = '40001', message = 'receipt draft is already in progress or failed';
  end if;
  select * into po_line_row from public.purchase_order_lines where id = p_purchase_order_line_id;
  select * into po_row from public.purchase_orders where id = po_line_row.purchase_order_id for update;
  if po_row.id is null or po_row.status not in ('ORDERED', 'PARTIALLY_RECEIVED', 'REOPENED') then
    raise exception 'Purchase order is not open for receipt';
  end if;
  perform 1 from public.seasonal_procurement_lines sp
  where sp.id = (select pol.seasonal_procurement_line_id from public.purchase_order_lines pol where pol.id = po_line_row.id) for update;
  for related_po_line in
    select pol.id from public.purchase_order_lines pol where pol.purchase_order_id = po_row.id order by pol.id for update
  loop null; end loop;
  select * into po_line_row from public.purchase_order_lines where id = p_purchase_order_line_id for update;
  insert into public.purchase_receipts (receipt_no, purchase_order_id, status, received_on, created_by)
  values (left(btrim(p_receipt_no), 80), po_row.id, 'DRAFT', p_received_on, current_account)
  returning * into receipt_row;
  insert into public.purchase_receipt_lines (
    receipt_id, purchase_order_id, purchase_order_line_id, item_id,
    delivered_quantity, accepted_quantity, rejected_quantity, rejection_reason,
    item_code_snapshot, item_name_snapshot
  ) values (
    receipt_row.id, po_row.id, po_line_row.id, po_line_row.item_id,
    p_delivered_quantity, p_accepted_quantity, p_rejected_quantity, nullif(btrim(p_rejection_reason), ''),
    po_line_row.item_code_snapshot, po_line_row.item_name_snapshot
  );
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'purchase_receipts', result_entity_id = receipt_row.id, succeeded_at = now()
  where id = command_row.id;
  return receipt_row;
end;
$$;

create or replace function public.post_purchase_receipt(
  p_receipt_id uuid,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.purchase_receipts
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  receipt_row public.purchase_receipts;
  po_row public.purchase_orders;
  po_line_row public.purchase_order_lines;
  receipt_line_row public.purchase_receipt_lines;
  general_warehouse_id uuid;
  balance_row public.inventory_balances;
  accepted_to_date bigint;
  delivered_to_date bigint;
  remaining_to_accept bigint;
  posting_id uuid;
  related_po_line record;
  locked_item_id uuid;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('WAREHOUSE') then
    raise exception using errcode = '42501', message = 'WAREHOUSE role is required';
  end if;
  if btrim(coalesce(p_idempotency_key, '')) = '' or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'idempotency_key and request_fingerprint are required';
  end if;
  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('POST_PURCHASE_RECEIPT', p_idempotency_key, p_request_fingerprint, current_account)
  on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands where operation_code = 'POST_PURCHASE_RECEIPT' and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' then select * into receipt_row from public.purchase_receipts where id = command_row.result_entity_id; return receipt_row; end if;
    raise exception using errcode = '40001', message = 'receipt POST is already in progress or failed';
  end if;
  select * into receipt_row from public.purchase_receipts where id = p_receipt_id;
  if receipt_row.id is null or receipt_row.status <> 'DRAFT' then raise exception 'Only DRAFT receipts can be posted'; end if;
  select * into receipt_line_row from public.purchase_receipt_lines where receipt_id = p_receipt_id order by id limit 1;
  select * into po_line_row from public.purchase_order_lines where id = receipt_line_row.purchase_order_line_id;
  if po_line_row.id is null then raise exception 'Receipt has no valid purchase order line'; end if;
  locked_item_id := po_line_row.item_id;
  if receipt_line_row.delivered_quantity <= 0 or receipt_line_row.accepted_quantity + receipt_line_row.rejected_quantity <> receipt_line_row.delivered_quantity then
    raise exception 'Receipt must have a complete quantity classification before POST';
  end if;
  if receipt_line_row.rejected_quantity > 0 and btrim(coalesce(receipt_line_row.rejection_reason, '')) = '' then
    raise exception 'A rejection reason is required before POST';
  end if;
  insert into public.inventory_item_locks (item_id) values (po_line_row.item_id) on conflict (item_id) do nothing;
  perform 1 from public.inventory_item_locks where item_id = po_line_row.item_id for update;
  select * into po_row from public.purchase_orders where id = receipt_row.purchase_order_id for update;
  if po_row.status not in ('ORDERED', 'PARTIALLY_RECEIVED', 'REOPENED') then raise exception 'Purchase order is closed for receipt'; end if;
  perform 1 from public.seasonal_procurement_lines sp where sp.id = (select pol.seasonal_procurement_line_id from public.purchase_order_lines pol join public.purchase_receipt_lines rpl on rpl.purchase_order_line_id = pol.id where rpl.receipt_id = p_receipt_id limit 1) for update;
  for related_po_line in select pol.id from public.purchase_order_lines pol where pol.purchase_order_id = po_row.id order by pol.id for update loop null; end loop;
  select * into receipt_row from public.purchase_receipts where id = p_receipt_id for update;
  if receipt_row.status <> 'DRAFT' then raise exception using errcode = '40001', message = 'Receipt changed while locking; retry'; end if;
  select * into receipt_line_row from public.purchase_receipt_lines where receipt_id = p_receipt_id order by id limit 1 for update;
  select * into po_line_row from public.purchase_order_lines where id = receipt_line_row.purchase_order_line_id for update;
  if po_line_row.item_id <> locked_item_id then raise exception using errcode = '40001', message = 'Receipt item changed while locking; retry'; end if;
  if receipt_line_row.delivered_quantity <= 0 or receipt_line_row.accepted_quantity + receipt_line_row.rejected_quantity <> receipt_line_row.delivered_quantity then raise exception 'Receipt must have a complete quantity classification before POST'; end if;
  if receipt_line_row.rejected_quantity > 0 and btrim(coalesce(receipt_line_row.rejection_reason, '')) = '' then raise exception 'A rejection reason is required before POST'; end if;
  select coalesce(sum(prl.accepted_quantity), 0) into accepted_to_date from public.purchase_receipt_lines prl join public.purchase_receipts pr on pr.id = prl.receipt_id where pr.purchase_order_id = po_row.id and pr.status = 'POSTED' and prl.purchase_order_line_id = po_line_row.id;
  select coalesce(sum(prl.delivered_quantity), 0) into delivered_to_date from public.purchase_receipt_lines prl join public.purchase_receipts pr on pr.id = prl.receipt_id where pr.purchase_order_id = po_row.id and pr.status = 'POSTED' and prl.purchase_order_line_id = po_line_row.id;
  remaining_to_accept := po_line_row.ordered_quantity - accepted_to_date;
  if receipt_line_row.accepted_quantity > remaining_to_accept or receipt_line_row.delivered_quantity > po_line_row.ordered_quantity - delivered_to_date then raise exception 'Receipt quantity exceeds the ordered quantity'; end if;
  select id into general_warehouse_id from public.warehouses where purpose = 'GENERAL' and is_active;
  if general_warehouse_id is null then raise exception 'An active GENERAL warehouse is required'; end if;
  insert into public.inventory_balances (warehouse_id, item_id) values (general_warehouse_id, po_line_row.item_id) on conflict (warehouse_id, item_id) do nothing;
  select * into balance_row from public.inventory_balances where warehouse_id = general_warehouse_id and item_id = po_line_row.item_id for update;
  insert into public.inventory_postings (idempotency_key, posting_kind, source_entity_id, posted_by) values (p_idempotency_key, 'RECEIPT', p_receipt_id, current_account) returning id into posting_id;
  insert into public.purchase_receipt_posting_sources (posting_id, receipt_id) values (posting_id, p_receipt_id);
  if receipt_line_row.accepted_quantity > 0 then
    insert into public.inventory_ledger_entries (posting_id, line_no, warehouse_id, item_id, movement_kind, quantity_delta, occurred_on) values (posting_id, 1, general_warehouse_id, po_line_row.item_id, 'RECEIPT_IN', receipt_line_row.accepted_quantity, receipt_row.received_on);
    update public.inventory_balances set on_hand_quantity = on_hand_quantity + receipt_line_row.accepted_quantity, version = version + 1, last_posting_id = posting_id, updated_at = now() where warehouse_id = general_warehouse_id and item_id = po_line_row.item_id;
  end if;
  update public.purchase_receipts set status = 'POSTED', posted_at = now(), posted_by = current_account where id = p_receipt_id returning * into receipt_row;
  select coalesce(sum(prl.accepted_quantity), 0) into accepted_to_date from public.purchase_receipt_lines prl join public.purchase_receipts pr on pr.id = prl.receipt_id where pr.purchase_order_id = po_row.id and pr.status = 'POSTED' and prl.purchase_order_line_id = po_line_row.id;
  if accepted_to_date >= po_line_row.ordered_quantity then update public.purchase_orders set status = 'RECEIVED' where id = po_row.id; else update public.purchase_orders set status = 'PARTIALLY_RECEIVED' where id = po_row.id; end if;
  update public.operation_commands set status = 'SUCCEEDED', result_entity_type = 'purchase_receipts', result_entity_id = p_receipt_id, succeeded_at = now() where id = command_row.id;
  return receipt_row;
end;
$$;

revoke all on function public.create_purchase_receipt_draft(text, uuid, bigint, bigint, bigint, text, date, text, text) from public, anon;
revoke all on function public.post_purchase_receipt(uuid, text, text) from public, anon;
grant execute on function public.create_purchase_receipt_draft(text, uuid, bigint, bigint, bigint, text, date, text, text) to authenticated;
grant execute on function public.post_purchase_receipt(uuid, text, text) to authenticated;
