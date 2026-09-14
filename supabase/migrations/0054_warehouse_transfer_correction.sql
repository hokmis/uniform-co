-- A signed correction to a posted warehouse transfer/replenishment.  The
-- source document and line remain immutable; only a correction delta moves
-- stock between GENERAL and HR.

alter table public.correction_notes
  add column if not exists original_warehouse_shipment_id uuid references public.warehouse_shipments(id),
  add column if not exists original_replenishment_request_id uuid references public.replenishment_requests(id);

alter table public.correction_notes
  drop constraint if exists correction_notes_correction_kind_check;
alter table public.correction_notes
  add constraint correction_notes_correction_kind_check check (
    (correction_kind = 'PURCHASE_RECEIPT'
      and original_purchase_receipt_id is not null and original_return_note_id is null
      and original_hr_request_id is null and original_warehouse_shipment_id is null
      and original_replenishment_request_id is null)
    or (correction_kind = 'RETURN'
      and original_purchase_receipt_id is null and original_return_note_id is not null
      and original_hr_request_id is null and original_warehouse_shipment_id is null
      and original_replenishment_request_id is null)
    or (correction_kind = 'HR_ISSUE'
      and original_purchase_receipt_id is null and original_return_note_id is null
      and original_hr_request_id is not null and original_warehouse_shipment_id is null
      and original_replenishment_request_id is null)
    or (correction_kind = 'WAREHOUSE_TRANSFER'
      and original_purchase_receipt_id is null and original_return_note_id is null
      and original_hr_request_id is null
      and num_nonnulls(original_warehouse_shipment_id, original_replenishment_request_id) = 1)
  );

alter table public.correction_notes
  add constraint correction_notes_id_shipment_unique unique (id, original_warehouse_shipment_id),
  add constraint correction_notes_id_replenishment_unique unique (id, original_replenishment_request_id);

alter table public.replenishment_request_lines
  add constraint replenishment_request_lines_request_id_id_unique unique (request_id, id);

create table public.warehouse_transfer_correction_lines (
  id uuid primary key default gen_random_uuid(),
  correction_note_id uuid not null,
  original_warehouse_shipment_id uuid,
  original_shipment_line_id uuid,
  original_replenishment_request_id uuid,
  original_replenishment_line_id uuid,
  item_id uuid not null references public.uniform_items(id),
  line_no integer not null default 1 check (line_no > 0),
  transfer_quantity_delta bigint not null check (transfer_quantity_delta <> 0),
  item_code_snapshot text,
  item_name_snapshot text,
  unit_snapshot text,
  unique (correction_note_id, line_no),
  unique (correction_note_id, id),
  unique (correction_note_id, original_shipment_line_id),
  unique (correction_note_id, original_replenishment_line_id),
  foreign key (correction_note_id, original_warehouse_shipment_id)
    references public.correction_notes(id, original_warehouse_shipment_id),
  foreign key (correction_note_id, original_replenishment_request_id)
    references public.correction_notes(id, original_replenishment_request_id),
  foreign key (original_warehouse_shipment_id, original_shipment_line_id)
    references public.warehouse_shipment_lines(shipment_id, id),
  foreign key (original_replenishment_request_id, original_replenishment_line_id)
    references public.replenishment_request_lines(request_id, id),
  check (num_nonnulls(original_shipment_line_id, original_replenishment_line_id) = 1),
  check (num_nonnulls(original_warehouse_shipment_id, original_replenishment_request_id) = 1)
);

create or replace function private.validate_warehouse_transfer_correction_line()
returns trigger
language plpgsql security definer set search_path = pg_catalog, private
as $$
declare
  shipment_line public.warehouse_shipment_lines;
  replenishment_line public.replenishment_request_lines;
  item_row public.uniform_items;
begin
  if new.original_shipment_line_id is not null then
    select * into shipment_line from public.warehouse_shipment_lines
    where shipment_id = new.original_warehouse_shipment_id and id = new.original_shipment_line_id;
    if shipment_line.id is null then raise exception 'Shipment correction source line is invalid'; end if;
    if new.original_replenishment_request_id is not null or new.original_replenishment_line_id is not null then
      raise exception 'A transfer correction cannot mix source document kinds';
    end if;
    new.item_id := shipment_line.item_id;
  else
    select * into replenishment_line from public.replenishment_request_lines
    where request_id = new.original_replenishment_request_id and id = new.original_replenishment_line_id;
    if replenishment_line.id is null then raise exception 'Replenishment correction source line is invalid'; end if;
    if new.original_warehouse_shipment_id is not null or new.original_shipment_line_id is not null then
      raise exception 'A transfer correction cannot mix source document kinds';
    end if;
    new.item_id := replenishment_line.item_id;
  end if;
  select * into item_row from public.uniform_items where id = new.item_id;
  new.item_code_snapshot := item_row.item_code;
  new.item_name_snapshot := item_row.item_name;
  new.unit_snapshot := item_row.unit;
  return new;
end;
$$;

create trigger warehouse_transfer_correction_source_guard
before insert or update on public.warehouse_transfer_correction_lines
for each row execute function private.validate_warehouse_transfer_correction_line();
create trigger warehouse_transfer_correction_immutable_guard
before update or delete on public.warehouse_transfer_correction_lines
for each row execute function private.prevent_posted_correction_mutation();

create or replace function private.prevent_posted_correction_mutation()
returns trigger language plpgsql security definer set search_path = pg_catalog, private
as $$
begin
  if tg_table_name = 'correction_notes' then
    if old.status = 'POSTED' then raise exception 'Posted corrections are immutable'; end if;
    if old.correction_kind is distinct from new.correction_kind
       or old.original_purchase_receipt_id is distinct from new.original_purchase_receipt_id
       or old.original_return_note_id is distinct from new.original_return_note_id
       or old.original_hr_request_id is distinct from new.original_hr_request_id
       or old.original_warehouse_shipment_id is distinct from new.original_warehouse_shipment_id
       or old.original_replenishment_request_id is distinct from new.original_replenishment_request_id then
      raise exception 'Correction source cannot be changed';
    end if;
  elsif exists (select 1 from public.correction_notes c where c.id = old.correction_note_id and c.status = 'POSTED') then
    raise exception 'Posted correction lines are immutable';
  end if;
  return new;
end;
$$;

alter table public.warehouse_transfer_correction_lines enable row level security;
create policy warehouse_transfer_corrections_read on public.warehouse_transfer_correction_lines
  for select to authenticated using (private.has_role('HR') or private.has_role('WAREHOUSE'));
revoke all on table public.warehouse_transfer_correction_lines from public, anon, authenticated;
grant select on public.warehouse_transfer_correction_lines to authenticated;

create or replace function public.create_warehouse_transfer_correction_draft(
  p_correction_no text,
  p_source_kind text,
  p_source_line_id uuid,
  p_transfer_quantity_delta bigint,
  p_reason text,
  p_note text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.correction_notes
language plpgsql security definer set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  correction_row public.correction_notes;
  shipment_line public.warehouse_shipment_lines;
  shipment_row public.warehouse_shipments;
  replenishment_line public.replenishment_request_lines;
  replenishment_row public.replenishment_requests;
  source_item_id uuid;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('WAREHOUSE') then
    raise exception using errcode = '42501', message = 'WAREHOUSE role is required';
  end if;
  if btrim(coalesce(p_correction_no, '')) = ''
     or upper(btrim(coalesce(p_source_kind, ''))) not in ('SHIPMENT', 'REPLENISHMENT')
     or p_source_line_id is null or p_transfer_quantity_delta = 0
     or btrim(coalesce(p_reason, '')) = ''
     or btrim(coalesce(p_idempotency_key, '')) = ''
     or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'Transfer correction fields are invalid';
  end if;
  insert into public.operation_commands(operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('CREATE_WAREHOUSE_TRANSFER_CORRECTION', p_idempotency_key, p_request_fingerprint, current_account)
  on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'CREATE_WAREHOUSE_TRANSFER_CORRECTION' and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' then
      select * into correction_row from public.correction_notes where id = command_row.result_entity_id;
      return correction_row;
    end if;
    raise exception using errcode = '40001', message = 'Transfer correction draft is already in progress or failed';
  end if;

  if upper(btrim(p_source_kind)) = 'SHIPMENT' then
    select * into shipment_line from public.warehouse_shipment_lines where id = p_source_line_id;
    select * into shipment_row from public.warehouse_shipments where id = shipment_line.shipment_id;
    if shipment_line.id is null or shipment_row.id is null or shipment_row.status <> 'POSTED' then
      raise exception 'Only POSTED warehouse shipments can be corrected';
    end if;
    source_item_id := shipment_line.item_id;
    insert into public.inventory_item_locks(item_id) values (source_item_id) on conflict do nothing;
    perform 1 from public.inventory_item_locks l where l.item_id = source_item_id for update;
    select * into shipment_row from public.warehouse_shipments where id = shipment_row.id for update;
    select * into shipment_line from public.warehouse_shipment_lines where id = p_source_line_id for update;
    if shipment_row.status <> 'POSTED' then raise exception using errcode = '40001', message = 'Shipment changed while locking; retry'; end if;
    insert into public.correction_notes(correction_no, correction_kind, status, reason, note, original_warehouse_shipment_id, created_by)
    values (left(btrim(p_correction_no), 80), 'WAREHOUSE_TRANSFER', 'DRAFT', left(btrim(p_reason), 500), nullif(left(btrim(coalesce(p_note, '')), 1000), ''), shipment_row.id, current_account)
    returning * into correction_row;
    insert into public.warehouse_transfer_correction_lines(correction_note_id, original_warehouse_shipment_id, original_shipment_line_id, item_id, transfer_quantity_delta)
    values (correction_row.id, shipment_row.id, shipment_line.id, source_item_id, p_transfer_quantity_delta);
  else
    select * into replenishment_line from public.replenishment_request_lines where id = p_source_line_id;
    select * into replenishment_row from public.replenishment_requests where id = replenishment_line.request_id;
    if replenishment_line.id is null or replenishment_row.id is null or replenishment_row.status <> 'SHIPPED' then
      raise exception 'Only SHIPPED replenishment requests can be corrected';
    end if;
    source_item_id := replenishment_line.item_id;
    insert into public.inventory_item_locks(item_id) values (source_item_id) on conflict do nothing;
    perform 1 from public.inventory_item_locks l where l.item_id = source_item_id for update;
    select * into replenishment_row from public.replenishment_requests where id = replenishment_row.id for update;
    select * into replenishment_line from public.replenishment_request_lines where id = p_source_line_id for update;
    if replenishment_row.status <> 'SHIPPED' then raise exception using errcode = '40001', message = 'Replenishment changed while locking; retry'; end if;
    insert into public.correction_notes(correction_no, correction_kind, status, reason, note, original_replenishment_request_id, created_by)
    values (left(btrim(p_correction_no), 80), 'WAREHOUSE_TRANSFER', 'DRAFT', left(btrim(p_reason), 500), nullif(left(btrim(coalesce(p_note, '')), 1000), ''), replenishment_row.id, current_account)
    returning * into correction_row;
    insert into public.warehouse_transfer_correction_lines(correction_note_id, original_replenishment_request_id, original_replenishment_line_id, item_id, transfer_quantity_delta)
    values (correction_row.id, replenishment_row.id, replenishment_line.id, source_item_id, p_transfer_quantity_delta);
  end if;
  update public.operation_commands set status = 'SUCCEEDED', result_entity_type = 'correction_notes', result_entity_id = correction_row.id, succeeded_at = now() where id = command_row.id;
  return correction_row;
end;
$$;

create or replace function public.post_warehouse_transfer_correction(
  p_correction_note_id uuid,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.correction_notes
language plpgsql security definer set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  correction_row public.correction_notes;
  correction_line public.warehouse_transfer_correction_lines;
  shipment_line public.warehouse_shipment_lines;
  shipment_row public.warehouse_shipments;
  replenishment_line public.replenishment_request_lines;
  replenishment_row public.replenishment_requests;
  item_lock_id uuid;
  hr_warehouse_id uuid;
  general_warehouse_id uuid;
  general_balance public.inventory_balances;
  hr_balance public.inventory_balances;
  prior_delta bigint;
  effective_transfer bigint;
  requested_max bigint;
  source_kind text;
  posting_id uuid;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('WAREHOUSE') then
    raise exception using errcode = '42501', message = 'WAREHOUSE role is required';
  end if;
  if btrim(coalesce(p_idempotency_key, '')) = '' or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'idempotency_key and request_fingerprint are required';
  end if;
  insert into public.operation_commands(operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('POST_WAREHOUSE_TRANSFER_CORRECTION', p_idempotency_key, p_request_fingerprint, current_account)
  on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands where operation_code = 'POST_WAREHOUSE_TRANSFER_CORRECTION' and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' then select * into correction_row from public.correction_notes where id = command_row.result_entity_id; return correction_row; end if;
    raise exception using errcode = '40001', message = 'Transfer correction POST is already in progress or failed';
  end if;
  select * into correction_row from public.correction_notes where id = p_correction_note_id and correction_kind = 'WAREHOUSE_TRANSFER';
  select * into correction_line from public.warehouse_transfer_correction_lines where correction_note_id = p_correction_note_id limit 1;
  if correction_row.id is null or correction_row.status <> 'DRAFT' or correction_line.id is null then raise exception 'Only a DRAFT transfer correction can be posted'; end if;
  source_kind := case when correction_line.original_shipment_line_id is not null then 'SHIPMENT' else 'REPLENISHMENT' end;
  insert into public.inventory_item_locks(item_id) values (correction_line.item_id) on conflict do nothing;
  select item_id into item_lock_id from public.inventory_item_locks where item_id = correction_line.item_id for update;
  select * into correction_row from public.correction_notes where id = p_correction_note_id for update;
  select * into correction_line from public.warehouse_transfer_correction_lines where correction_note_id = p_correction_note_id limit 1 for update;
  if source_kind = 'SHIPMENT' then
    select * into shipment_row from public.warehouse_shipments where id = correction_line.original_warehouse_shipment_id for update;
    select * into shipment_line from public.warehouse_shipment_lines where shipment_id = shipment_row.id and id = correction_line.original_shipment_line_id for update;
    if shipment_row.status <> 'POSTED' or shipment_line.item_id <> correction_line.item_id then raise exception using errcode = '40001', message = 'Shipment source changed while locking; retry'; end if;
    requested_max := shipment_line.requested_transfer_quantity_snapshot;
    if requested_max is null or shipment_line.actual_transfer_quantity is null then raise exception 'Posted shipment line lacks transfer snapshot'; end if;
  else
    select * into replenishment_row from public.replenishment_requests where id = correction_line.original_replenishment_request_id for update;
    select * into replenishment_line from public.replenishment_request_lines where request_id = replenishment_row.id and id = correction_line.original_replenishment_line_id for update;
    if replenishment_row.status <> 'SHIPPED' or replenishment_line.item_id <> correction_line.item_id then raise exception using errcode = '40001', message = 'Replenishment source changed while locking; retry'; end if;
    requested_max := replenishment_line.requested_quantity;
    if replenishment_line.actual_transfer_quantity is null then raise exception 'Posted replenishment line lacks transfer snapshot'; end if;
  end if;
  select coalesce(sum(transfer_quantity_delta), 0) into prior_delta
  from public.warehouse_transfer_correction_lines l
  join public.correction_notes c on c.id = l.correction_note_id
  where c.status = 'POSTED'
    and ((source_kind = 'SHIPMENT' and l.original_shipment_line_id = correction_line.original_shipment_line_id)
      or (source_kind = 'REPLENISHMENT' and l.original_replenishment_line_id = correction_line.original_replenishment_line_id));
  effective_transfer := case when source_kind = 'SHIPMENT' then shipment_line.actual_transfer_quantity else replenishment_line.actual_transfer_quantity end;
  effective_transfer := effective_transfer + prior_delta + correction_line.transfer_quantity_delta;
  if effective_transfer < 0 or effective_transfer > requested_max then raise exception 'Effective transfer quantity is outside the source limits'; end if;
  select id into hr_warehouse_id from public.warehouses where purpose = 'HR' and is_active order by id limit 1;
  select id into general_warehouse_id from public.warehouses where purpose = 'GENERAL' and is_active order by id limit 1;
  if hr_warehouse_id is null or general_warehouse_id is null then raise exception 'Both active HR and GENERAL warehouses are required'; end if;
  insert into public.inventory_balances(warehouse_id, item_id) values (hr_warehouse_id, correction_line.item_id), (general_warehouse_id, correction_line.item_id) on conflict do nothing;
  perform 1 from public.inventory_balances b where b.item_id = correction_line.item_id and b.warehouse_id in (hr_warehouse_id, general_warehouse_id) order by b.warehouse_id for update;
  select * into general_balance from public.inventory_balances where warehouse_id = general_warehouse_id and item_id = correction_line.item_id;
  select * into hr_balance from public.inventory_balances where warehouse_id = hr_warehouse_id and item_id = correction_line.item_id;
  if correction_line.transfer_quantity_delta > 0 and general_balance.on_hand_quantity < correction_line.transfer_quantity_delta then raise exception 'Transfer correction exceeds GENERAL stock'; end if;
  if correction_line.transfer_quantity_delta < 0 and hr_balance.on_hand_quantity < -correction_line.transfer_quantity_delta then raise exception 'Transfer reversal exceeds HR stock'; end if;
  insert into public.inventory_postings(idempotency_key, posting_kind, source_entity_id, posted_by) values (p_idempotency_key, 'CORRECTION', p_correction_note_id, current_account) returning id into posting_id;
  insert into public.correction_posting_sources(posting_id, correction_note_id) values (posting_id, p_correction_note_id);
  insert into public.inventory_ledger_entries(posting_id, line_no, warehouse_id, item_id, movement_kind, quantity_delta, occurred_on) values
    (posting_id, 1, general_warehouse_id, correction_line.item_id, 'WAREHOUSE_TRANSFER_CORRECTION_OUT', -correction_line.transfer_quantity_delta, current_date),
    (posting_id, 2, hr_warehouse_id, correction_line.item_id, 'WAREHOUSE_TRANSFER_CORRECTION_IN', correction_line.transfer_quantity_delta, current_date);
  update public.inventory_balances set on_hand_quantity = on_hand_quantity - correction_line.transfer_quantity_delta, version = version + 1, last_posting_id = posting_id, updated_at = now() where warehouse_id = general_warehouse_id and item_id = correction_line.item_id;
  update public.inventory_balances set on_hand_quantity = on_hand_quantity + correction_line.transfer_quantity_delta, version = version + 1, last_posting_id = posting_id, updated_at = now() where warehouse_id = hr_warehouse_id and item_id = correction_line.item_id;
  update public.correction_notes set status = 'POSTED', posted_at = now(), posted_by = current_account where id = p_correction_note_id returning * into correction_row;
  update public.operation_commands set status = 'SUCCEEDED', result_entity_type = 'correction_notes', result_entity_id = p_correction_note_id, succeeded_at = now() where id = command_row.id;
  return correction_row;
end;
$$;

create or replace function public.get_warehouse_transfer_correction_status(
  p_correction_note_id uuid default null,
  p_create_idempotency_key text default null,
  p_post_idempotency_key text default null
)
returns public.correction_notes
language plpgsql security definer set search_path = pg_catalog, private
as $$
declare current_account uuid; correction_id uuid := p_correction_note_id; correction_row public.correction_notes;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' or current_account is null or not private.has_role('WAREHOUSE') then raise exception using errcode = '42501', message = 'WAREHOUSE role is required'; end if;
  if correction_id is null and btrim(coalesce(p_create_idempotency_key, '')) <> '' then select result_entity_id into correction_id from public.operation_commands where operation_code = 'CREATE_WAREHOUSE_TRANSFER_CORRECTION' and idempotency_key = p_create_idempotency_key and actor_account_id = current_account; end if;
  if correction_id is null and btrim(coalesce(p_post_idempotency_key, '')) <> '' then select result_entity_id into correction_id from public.operation_commands where operation_code = 'POST_WAREHOUSE_TRANSFER_CORRECTION' and idempotency_key = p_post_idempotency_key and actor_account_id = current_account; end if;
  if correction_id is null then return null; end if;
  select * into correction_row from public.correction_notes where id = correction_id and created_by = current_account and correction_kind = 'WAREHOUSE_TRANSFER';
  return correction_row;
end;
$$;

revoke all on function public.create_warehouse_transfer_correction_draft(text, text, uuid, bigint, text, text, text, text) from public, anon;
revoke all on function public.post_warehouse_transfer_correction(uuid, text, text) from public, anon;
revoke all on function public.get_warehouse_transfer_correction_status(uuid, text, text) from public, anon;
grant execute on function public.create_warehouse_transfer_correction_draft(text, text, uuid, bigint, text, text, text, text) to authenticated;
grant execute on function public.post_warehouse_transfer_correction(uuid, text, text) to authenticated;
grant execute on function public.get_warehouse_transfer_correction_status(uuid, text, text) to authenticated;
