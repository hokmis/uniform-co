-- Immutable purchase receipt corrections with effective quantity recomputation.

alter table public.purchase_receipt_lines
  add constraint purchase_receipt_lines_receipt_id_id_unique unique (receipt_id, id);

create table public.correction_notes (
  id uuid primary key default gen_random_uuid(),
  correction_no text not null unique check (btrim(correction_no) <> ''),
  correction_kind text not null check (correction_kind in ('PURCHASE_RECEIPT')),
  status text not null default 'DRAFT' check (status in ('DRAFT', 'POSTED')),
  reason text not null check (btrim(reason) <> ''),
  original_purchase_receipt_id uuid not null references public.purchase_receipts(id),
  created_by uuid not null references public.app_accounts(id),
  posted_at timestamptz,
  posted_by uuid references public.app_accounts(id),
  unique (id, original_purchase_receipt_id)
);

create table public.purchase_receipt_correction_lines (
  id uuid primary key default gen_random_uuid(),
  correction_note_id uuid not null,
  original_purchase_receipt_id uuid not null,
  original_receipt_line_id uuid not null,
  item_id uuid not null references public.uniform_items(id),
  delivered_quantity_delta bigint not null default 0,
  accepted_quantity_delta bigint not null default 0,
  rejected_quantity_delta bigint not null default 0,
  rejection_reason_snapshot text,
  item_code_snapshot text not null,
  item_name_snapshot text not null,
  unique (correction_note_id, original_receipt_line_id),
  unique (correction_note_id, id),
  foreign key (correction_note_id, original_purchase_receipt_id)
    references public.correction_notes(id, original_purchase_receipt_id),
  foreign key (original_purchase_receipt_id, original_receipt_line_id)
    references public.purchase_receipt_lines(receipt_id, id),
  check (delivered_quantity_delta <> 0 or accepted_quantity_delta <> 0 or rejected_quantity_delta <> 0),
  check (rejected_quantity_delta <= 0 or btrim(coalesce(rejection_reason_snapshot, '')) <> '')
);

create table public.correction_posting_sources (
  posting_id uuid primary key references public.inventory_postings(id),
  correction_note_id uuid not null unique references public.correction_notes(id)
);

create or replace function private.validate_purchase_receipt_correction_line()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  source_line public.purchase_receipt_lines;
begin
  select * into source_line from public.purchase_receipt_lines
  where receipt_id = new.original_purchase_receipt_id and id = new.original_receipt_line_id;
  if source_line.id is null then
    raise exception 'Original receipt line does not belong to the correction receipt';
  end if;
  new.item_id := source_line.item_id;
  new.item_code_snapshot := source_line.item_code_snapshot;
  new.item_name_snapshot := source_line.item_name_snapshot;
  if new.rejected_quantity_delta > 0 and btrim(coalesce(new.rejection_reason_snapshot, '')) = '' then
    raise exception 'A rejection reason is required for a positive rejected delta';
  end if;
  return new;
end;
$$;

create trigger purchase_receipt_correction_source_guard
before insert or update on public.purchase_receipt_correction_lines
for each row execute function private.validate_purchase_receipt_correction_line();

create or replace function private.prevent_posted_correction_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  if tg_table_name = 'correction_notes' then
    if old.status = 'POSTED' then raise exception 'Posted corrections are immutable'; end if;
    if old.original_purchase_receipt_id <> new.original_purchase_receipt_id then
      raise exception 'Correction source cannot be changed';
    end if;
  elsif exists (
    select 1 from public.correction_notes c
    where c.id = old.correction_note_id and c.status = 'POSTED'
  ) then
    raise exception 'Posted correction lines are immutable';
  end if;
  return new;
end;
$$;

create trigger correction_notes_immutable_guard
before update or delete on public.correction_notes
for each row execute function private.prevent_posted_correction_mutation();
create trigger purchase_receipt_correction_lines_immutable_guard
before update or delete on public.purchase_receipt_correction_lines
for each row execute function private.prevent_posted_correction_mutation();

alter table public.correction_notes enable row level security;
alter table public.purchase_receipt_correction_lines enable row level security;
alter table public.correction_posting_sources enable row level security;
create policy correction_notes_read on public.correction_notes
  for select to authenticated using (private.has_role('HR') or private.has_role('WAREHOUSE'));
create policy purchase_receipt_corrections_read on public.purchase_receipt_correction_lines
  for select to authenticated using (private.has_role('HR') or private.has_role('WAREHOUSE'));
revoke all on table public.correction_notes, public.purchase_receipt_correction_lines,
  public.correction_posting_sources from public, anon, authenticated;
grant select on public.correction_notes, public.purchase_receipt_correction_lines to authenticated;

create or replace function public.create_purchase_receipt_correction_draft(
  p_correction_no text,
  p_original_receipt_line_id uuid,
  p_delivered_quantity_delta bigint,
  p_accepted_quantity_delta bigint,
  p_rejected_quantity_delta bigint,
  p_rejection_reason text,
  p_reason text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.correction_notes
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  source_line public.purchase_receipt_lines;
  correction_row public.correction_notes;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('WAREHOUSE') then
    raise exception using errcode = '42501', message = 'WAREHOUSE role is required';
  end if;
  if btrim(coalesce(p_correction_no, '')) = '' or btrim(coalesce(p_reason, '')) = ''
     or (p_delivered_quantity_delta = 0 and p_accepted_quantity_delta = 0 and p_rejected_quantity_delta = 0)
     or (p_rejected_quantity_delta > 0 and btrim(coalesce(p_rejection_reason, '')) = '') then
    raise exception 'Correction fields are invalid';
  end if;
  if btrim(coalesce(p_idempotency_key, '')) = '' or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'idempotency_key and request_fingerprint are required';
  end if;
  insert into public.operation_commands (
    operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id
  ) values (
    'CREATE_PURCHASE_RECEIPT_CORRECTION', p_idempotency_key, p_request_fingerprint, current_account
  ) on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'CREATE_PURCHASE_RECEIPT_CORRECTION' and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' then
      select * into correction_row from public.correction_notes where id = command_row.result_entity_id;
      return correction_row;
    end if;
    raise exception using errcode = '40001', message = 'Correction draft is already in progress or failed';
  end if;
  select * into source_line from public.purchase_receipt_lines where id = p_original_receipt_line_id;
  if source_line.id is null then raise exception 'Original receipt line not found'; end if;
  if not exists (
    select 1 from public.purchase_receipts pr
    where pr.id = source_line.receipt_id and pr.status = 'POSTED'
  ) then raise exception 'Only POSTED receipts can be corrected'; end if;
  insert into public.correction_notes (
    correction_no, correction_kind, status, reason, original_purchase_receipt_id, created_by
  ) values (
    left(btrim(p_correction_no), 80), 'PURCHASE_RECEIPT', 'DRAFT', left(btrim(p_reason), 500),
    source_line.receipt_id, current_account
  ) returning * into correction_row;
  insert into public.purchase_receipt_correction_lines (
    correction_note_id, original_purchase_receipt_id, original_receipt_line_id,
    item_id, delivered_quantity_delta, accepted_quantity_delta, rejected_quantity_delta,
    rejection_reason_snapshot, item_code_snapshot, item_name_snapshot
  ) values (
    correction_row.id, source_line.receipt_id, source_line.id, source_line.item_id,
    p_delivered_quantity_delta, p_accepted_quantity_delta, p_rejected_quantity_delta,
    nullif(btrim(p_rejection_reason), ''), source_line.item_code_snapshot, source_line.item_name_snapshot
  );
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'correction_notes',
      result_entity_id = correction_row.id, succeeded_at = now()
  where id = command_row.id;
  return correction_row;
end;
$$;

create or replace function public.post_purchase_receipt_correction(
  p_correction_note_id uuid,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.correction_notes
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  correction_row public.correction_notes;
  correction_line public.purchase_receipt_correction_lines;
  source_line public.purchase_receipt_lines;
  receipt_row public.purchase_receipts;
  po_row public.purchase_orders;
  po_line_row public.purchase_order_lines;
  procurement_id uuid;
  general_warehouse_id uuid;
  balance_row public.inventory_balances;
  effective_delivered bigint;
  effective_accepted bigint;
  effective_rejected bigint;
  new_delivered bigint;
  new_accepted bigint;
  new_rejected bigint;
  accepted_delta bigint;
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
  insert into public.operation_commands (
    operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id
  ) values (
    'POST_PURCHASE_RECEIPT_CORRECTION', p_idempotency_key, p_request_fingerprint, current_account
  ) on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'POST_PURCHASE_RECEIPT_CORRECTION' and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' then
      select * into correction_row from public.correction_notes where id = command_row.result_entity_id;
      return correction_row;
    end if;
    raise exception using errcode = '40001', message = 'Correction POST is already in progress or failed';
  end if;
  select * into correction_row from public.correction_notes where id = p_correction_note_id;
  if correction_row.id is null or correction_row.status <> 'DRAFT' then raise exception 'Only DRAFT corrections can be posted'; end if;
  select * into correction_line from public.purchase_receipt_correction_lines
  where correction_note_id = p_correction_note_id order by id limit 1;
  select * into source_line from public.purchase_receipt_lines
  where receipt_id = correction_line.original_purchase_receipt_id and id = correction_line.original_receipt_line_id;
  select * into receipt_row from public.purchase_receipts where id = source_line.receipt_id;
  select * into po_line_row from public.purchase_order_lines where id = (
    select prl.purchase_order_line_id from public.purchase_receipt_lines prl
    where prl.receipt_id = source_line.receipt_id and prl.id = source_line.id
  );
  locked_item_id := source_line.item_id;
  insert into public.inventory_item_locks (item_id) values (locked_item_id) on conflict (item_id) do nothing;
  perform 1 from public.inventory_item_locks where item_id = locked_item_id for update;
  select * into po_row from public.purchase_orders where id = receipt_row.purchase_order_id for update;
  if po_row.id is null then raise exception 'Source purchase order not found'; end if;
  select seasonal_procurement_line_id into procurement_id from public.purchase_order_lines where id = po_line_row.id;
  perform 1 from public.seasonal_procurement_lines where id = procurement_id for update;
  for related_po_line in
    select pol.id from public.purchase_order_lines pol
    where pol.purchase_order_id = po_row.id order by pol.id for update
  loop
    null;
  end loop;
  select * into correction_row from public.correction_notes where id = p_correction_note_id for update;
  select * into correction_line from public.purchase_receipt_correction_lines
  where correction_note_id = p_correction_note_id order by id limit 1 for update;
  select * into source_line from public.purchase_receipt_lines
  where receipt_id = correction_line.original_purchase_receipt_id and id = correction_line.original_receipt_line_id for update;
  if correction_row.status <> 'DRAFT' then raise exception using errcode = '40001', message = 'Correction changed while locking; retry'; end if;
  select coalesce(sum(prl.delivered_quantity), 0),
         coalesce(sum(prl.accepted_quantity), 0),
         coalesce(sum(prl.rejected_quantity), 0)
    into effective_delivered, effective_accepted, effective_rejected
  from public.purchase_receipt_lines prl
  join public.purchase_receipts pr on pr.id = prl.receipt_id
  where prl.receipt_id = source_line.receipt_id and prl.id = source_line.id and pr.status = 'POSTED';
  select coalesce(effective_delivered, 0) + coalesce(sum(cl.delivered_quantity_delta), 0),
         coalesce(effective_accepted, 0) + coalesce(sum(cl.accepted_quantity_delta), 0),
         coalesce(effective_rejected, 0) + coalesce(sum(cl.rejected_quantity_delta), 0)
    into new_delivered, new_accepted, new_rejected
  from public.purchase_receipt_correction_lines cl
  join public.correction_notes cn on cn.id = cl.correction_note_id
  where cl.original_purchase_receipt_id = source_line.receipt_id
    and cl.original_receipt_line_id = source_line.id and cn.status = 'POSTED';
  new_delivered := new_delivered + correction_line.delivered_quantity_delta;
  new_accepted := new_accepted + correction_line.accepted_quantity_delta;
  new_rejected := new_rejected + correction_line.rejected_quantity_delta;
  if new_delivered < 0 or new_accepted < 0 or new_rejected < 0
     or new_accepted + new_rejected <> new_delivered then
    raise exception 'Correction would leave invalid effective receipt classification';
  end if;
  if new_accepted > po_line_row.ordered_quantity then
    raise exception 'Effective accepted quantity exceeds ordered quantity';
  end if;
  accepted_delta := new_accepted - effective_accepted;
  select id into general_warehouse_id from public.warehouses where purpose = 'GENERAL' and is_active;
  if general_warehouse_id is null then raise exception 'An active GENERAL warehouse is required'; end if;
  insert into public.inventory_balances (warehouse_id, item_id)
  values (general_warehouse_id, source_line.item_id) on conflict (warehouse_id, item_id) do nothing;
  select * into balance_row from public.inventory_balances
  where warehouse_id = general_warehouse_id and item_id = source_line.item_id for update;
  if accepted_delta < 0 and balance_row.on_hand_quantity < -accepted_delta then
    raise exception 'Correction would make GENERAL stock negative';
  end if;
  insert into public.inventory_postings (
    idempotency_key, posting_kind, source_entity_id, posted_by
  ) values (p_idempotency_key, 'CORRECTION', p_correction_note_id, current_account)
  returning id into posting_id;
  insert into public.correction_posting_sources (posting_id, correction_note_id)
  values (posting_id, p_correction_note_id);
  if accepted_delta <> 0 then
    insert into public.inventory_ledger_entries (
      posting_id, line_no, warehouse_id, item_id, movement_kind, quantity_delta, occurred_on
    ) values (
      posting_id, 1, general_warehouse_id, source_line.item_id,
      'RECEIPT_CORRECTION', accepted_delta, current_date
    );
    update public.inventory_balances
    set on_hand_quantity = on_hand_quantity + accepted_delta,
        version = version + 1, last_posting_id = posting_id, updated_at = now()
    where warehouse_id = general_warehouse_id and item_id = source_line.item_id;
  end if;
  update public.correction_notes
  set status = 'POSTED', posted_at = now(), posted_by = current_account
  where id = p_correction_note_id returning * into correction_row;
  if po_row.status <> 'CLOSED_SHORT' then
    if exists (
      select 1 from public.purchase_order_lines pol
      where pol.purchase_order_id = po_row.id
        and pol.ordered_quantity > (
          coalesce((select sum(prl.accepted_quantity) from public.purchase_receipt_lines prl
            join public.purchase_receipts pr on pr.id = prl.receipt_id
            where pr.purchase_order_id = po_row.id and pr.status = 'POSTED'
              and prl.purchase_order_line_id = pol.id), 0)
          + coalesce((select sum(cl.accepted_quantity_delta) from public.purchase_receipt_correction_lines cl
            join public.correction_notes cn on cn.id = cl.correction_note_id
            where cl.original_purchase_receipt_id in (select id from public.purchase_receipts where purchase_order_id = po_row.id)
              and cl.original_receipt_line_id in (select id from public.purchase_receipt_lines where purchase_order_line_id = pol.id)
              and cn.status = 'POSTED'), 0)
        )
    ) then
      update public.purchase_orders
      set status = case when po_row.status = 'RECEIVED' then 'REOPENED' else 'PARTIALLY_RECEIVED' end
      where id = po_row.id;
    else
      update public.purchase_orders set status = 'RECEIVED' where id = po_row.id;
    end if;
  end if;
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'correction_notes',
      result_entity_id = p_correction_note_id, succeeded_at = now()
  where id = command_row.id;
  return correction_row;
end;
$$;

revoke all on function public.create_purchase_receipt_correction_draft(text, uuid, bigint, bigint, bigint, text, text, text, text) from public, anon;
revoke all on function public.post_purchase_receipt_correction(uuid, text, text) from public, anon;
grant execute on function public.create_purchase_receipt_correction_draft(text, uuid, bigint, bigint, bigint, text, text, text, text) to authenticated;
grant execute on function public.post_purchase_receipt_correction(uuid, text, text) to authenticated;
