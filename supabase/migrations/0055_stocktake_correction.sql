alter table public.correction_notes
  add column if not exists original_stocktake_id uuid references public.stocktakes(id);

alter table public.correction_notes
  drop constraint if exists correction_notes_correction_kind_check;
alter table public.correction_notes
  add constraint correction_notes_correction_kind_check check (
    (correction_kind = 'PURCHASE_RECEIPT' and original_purchase_receipt_id is not null and original_return_note_id is null and original_hr_request_id is null and original_warehouse_shipment_id is null and original_replenishment_request_id is null and original_stocktake_id is null)
    or (correction_kind = 'RETURN' and original_purchase_receipt_id is null and original_return_note_id is not null and original_hr_request_id is null and original_warehouse_shipment_id is null and original_replenishment_request_id is null and original_stocktake_id is null)
    or (correction_kind = 'HR_ISSUE' and original_purchase_receipt_id is null and original_return_note_id is null and original_hr_request_id is not null and original_warehouse_shipment_id is null and original_replenishment_request_id is null and original_stocktake_id is null)
    or (correction_kind = 'WAREHOUSE_TRANSFER' and original_purchase_receipt_id is null and original_return_note_id is null and original_hr_request_id is null and num_nonnulls(original_warehouse_shipment_id, original_replenishment_request_id) = 1 and original_stocktake_id is null)
    or (correction_kind = 'STOCKTAKE' and original_purchase_receipt_id is null and original_return_note_id is null and original_hr_request_id is null and original_warehouse_shipment_id is null and original_replenishment_request_id is null and original_stocktake_id is not null)
  );
alter table public.correction_notes add constraint correction_notes_id_stocktake_unique unique (id, original_stocktake_id);

alter table public.stocktake_lines
  add constraint stocktake_lines_stocktake_id_id_unique unique (stocktake_id, id);

create table public.stocktake_correction_lines (
  id uuid primary key default gen_random_uuid(),
  correction_note_id uuid not null,
  original_stocktake_id uuid not null,
  original_stocktake_line_id uuid not null,
  item_id uuid not null references public.uniform_items(id),
  warehouse_id uuid not null references public.warehouses(id),
  counted_quantity_delta bigint not null check (counted_quantity_delta <> 0),
  item_code_snapshot text,
  item_name_snapshot text,
  unit_snapshot text,
  unique (correction_note_id, original_stocktake_line_id),
  unique (correction_note_id, id),
  foreign key (correction_note_id, original_stocktake_id) references public.correction_notes(id, original_stocktake_id),
  foreign key (original_stocktake_id, original_stocktake_line_id) references public.stocktake_lines(stocktake_id, id)
);

create or replace function private.validate_stocktake_correction_line()
returns trigger language plpgsql security definer set search_path = pg_catalog, private
as $$
declare source_line public.stocktake_lines; item_row public.uniform_items; stocktake_row public.stocktakes;
begin
  select * into source_line from public.stocktake_lines where stocktake_id = new.original_stocktake_id and id = new.original_stocktake_line_id;
  select * into stocktake_row from public.stocktakes where id = new.original_stocktake_id;
  if source_line.id is null or stocktake_row.id is null or stocktake_row.status <> 'POSTED' then raise exception 'Only POSTED stocktake lines can be corrected'; end if;
  new.item_id := source_line.item_id; new.warehouse_id := stocktake_row.warehouse_id;
  select * into item_row from public.uniform_items where id = new.item_id;
  new.item_code_snapshot := item_row.item_code; new.item_name_snapshot := item_row.item_name; new.unit_snapshot := item_row.unit;
  return new;
end;
$$;
create trigger stocktake_correction_source_guard before insert or update on public.stocktake_correction_lines for each row execute function private.validate_stocktake_correction_line();
create trigger stocktake_correction_immutable_guard before update or delete on public.stocktake_correction_lines for each row execute function private.prevent_posted_correction_mutation();

alter table public.stocktake_correction_lines enable row level security;
create policy stocktake_corrections_read on public.stocktake_correction_lines for select to authenticated using (private.has_role('HR') or private.has_role('WAREHOUSE'));
revoke all on table public.stocktake_correction_lines from public, anon, authenticated;
grant select on public.stocktake_correction_lines to authenticated;

create or replace function public.create_stocktake_correction_draft(
  p_correction_no text, p_original_stocktake_line_id uuid, p_counted_quantity_delta bigint,
  p_reason text, p_note text, p_idempotency_key text, p_request_fingerprint text
)
returns public.correction_notes language plpgsql security definer set search_path = pg_catalog, private
as $$
declare current_account uuid; command_row public.operation_commands; correction_row public.correction_notes; source_line public.stocktake_lines; stocktake_row public.stocktakes; item_lock_id uuid;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' or current_account is null then raise exception using errcode = '42501', message = 'An authenticated app account is required'; end if;
  if btrim(coalesce(p_correction_no, '')) = '' or p_original_stocktake_line_id is null or p_counted_quantity_delta = 0 or btrim(coalesce(p_reason, '')) = '' or btrim(coalesce(p_idempotency_key, '')) = '' or btrim(coalesce(p_request_fingerprint, '')) = '' then raise exception 'Stocktake correction fields are invalid'; end if;
  insert into public.operation_commands(operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id) values ('CREATE_STOCKTAKE_CORRECTION', p_idempotency_key, p_request_fingerprint, current_account) on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands where operation_code = 'CREATE_STOCKTAKE_CORRECTION' and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account or command_row.canonical_request_fingerprint <> p_request_fingerprint then raise exception using errcode = '40001', message = 'idempotency key conflicts with another request'; end if;
    if command_row.status = 'SUCCEEDED' then select * into correction_row from public.correction_notes where id = command_row.result_entity_id; return correction_row; end if;
    raise exception using errcode = '40001', message = 'Stocktake correction draft is already in progress or failed';
  end if;
  select * into source_line from public.stocktake_lines where id = p_original_stocktake_line_id;
  select * into stocktake_row from public.stocktakes where id = source_line.stocktake_id;
  if source_line.id is null or stocktake_row.id is null or stocktake_row.status <> 'POSTED' then raise exception 'Only POSTED stocktake lines can be corrected'; end if;
  if (stocktake_row.warehouse_id in (select id from public.warehouses where purpose = 'HR') and not private.has_role('HR')) or (stocktake_row.warehouse_id in (select id from public.warehouses where purpose = 'GENERAL') and not private.has_role('WAREHOUSE')) then raise exception using errcode = '42501', message = 'The account cannot correct this stocktake warehouse'; end if;
  insert into public.inventory_item_locks(item_id) values (source_line.item_id) on conflict do nothing;
  select item_id into item_lock_id from public.inventory_item_locks where item_id = source_line.item_id for update;
  select * into stocktake_row from public.stocktakes where id = source_line.stocktake_id for update;
  select * into source_line from public.stocktake_lines where id = p_original_stocktake_line_id for update;
  insert into public.correction_notes(correction_no, correction_kind, status, reason, note, original_stocktake_id, created_by) values (left(btrim(p_correction_no),80), 'STOCKTAKE', 'DRAFT', left(btrim(p_reason),500), nullif(left(btrim(coalesce(p_note,'')),1000),''), stocktake_row.id, current_account) returning * into correction_row;
  insert into public.stocktake_correction_lines(correction_note_id, original_stocktake_id, original_stocktake_line_id, item_id, warehouse_id, counted_quantity_delta) values (correction_row.id, stocktake_row.id, source_line.id, source_line.item_id, stocktake_row.warehouse_id, p_counted_quantity_delta);
  update public.operation_commands set status = 'SUCCEEDED', result_entity_type = 'correction_notes', result_entity_id = correction_row.id, succeeded_at = now() where id = command_row.id;
  return correction_row;
end;
$$;

create or replace function public.post_stocktake_correction(p_correction_note_id uuid, p_idempotency_key text, p_request_fingerprint text)
returns public.correction_notes language plpgsql security definer set search_path = pg_catalog, private
as $$
declare
  current_account uuid; command_row public.operation_commands; correction_row public.correction_notes; correction_line public.stocktake_correction_lines; source_line public.stocktake_lines; stocktake_row public.stocktakes; item_lock_id uuid; balance_row public.inventory_balances; hr_warehouse_id uuid; general_warehouse_id uuid; warehouse_purpose text; combined_on_hand bigint; active_reserved bigint; affected_request_ids uuid[]; request_id_row record; item_id_row record; posting_id uuid; effective_counted bigint;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' or current_account is null then raise exception using errcode = '42501', message = 'An authenticated app account is required'; end if;
  if btrim(coalesce(p_idempotency_key,'')) = '' or btrim(coalesce(p_request_fingerprint,'')) = '' then raise exception 'idempotency_key and request_fingerprint are required'; end if;
  insert into public.operation_commands(operation_code,idempotency_key,canonical_request_fingerprint,actor_account_id) values ('POST_STOCKTAKE_CORRECTION',p_idempotency_key,p_request_fingerprint,current_account) on conflict (operation_code,idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands where operation_code = 'POST_STOCKTAKE_CORRECTION' and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account or command_row.canonical_request_fingerprint <> p_request_fingerprint then raise exception using errcode = '40001', message = 'idempotency key conflicts with another request'; end if;
    if command_row.status = 'SUCCEEDED' then select * into correction_row from public.correction_notes where id = command_row.result_entity_id; return correction_row; end if;
    raise exception using errcode = '40001', message = 'Stocktake correction POST is already in progress or failed';
  end if;
  select * into correction_row from public.correction_notes where id = p_correction_note_id and correction_kind = 'STOCKTAKE';
  select * into correction_line from public.stocktake_correction_lines where correction_note_id = p_correction_note_id limit 1;
  if correction_row.id is null or correction_row.status <> 'DRAFT' or correction_line.id is null then raise exception 'Only a DRAFT stocktake correction can be posted'; end if;
  insert into public.inventory_item_locks(item_id) values (correction_line.item_id) on conflict do nothing;
  select item_id into item_lock_id from public.inventory_item_locks where item_id = correction_line.item_id for update;
  select * into correction_row from public.correction_notes where id = p_correction_note_id for update;
  select * into correction_line from public.stocktake_correction_lines where correction_note_id = p_correction_note_id limit 1 for update;
  select * into stocktake_row from public.stocktakes where id = correction_line.original_stocktake_id for update;
  select * into source_line from public.stocktake_lines where stocktake_id = stocktake_row.id and id = correction_line.original_stocktake_line_id for update;
  if correction_row.status <> 'DRAFT' or stocktake_row.status <> 'POSTED' or source_line.item_id <> correction_line.item_id then raise exception using errcode = '40001', message = 'Stocktake source changed while locking; retry'; end if;
  select purpose into warehouse_purpose from public.warehouses where id = stocktake_row.warehouse_id;
  if (warehouse_purpose = 'HR' and not private.has_role('HR')) or (warehouse_purpose = 'GENERAL' and not private.has_role('WAREHOUSE')) or warehouse_purpose is null then raise exception using errcode = '42501', message = 'The account cannot correct this stocktake warehouse'; end if;
  effective_counted := source_line.counted_quantity + correction_line.counted_quantity_delta;
  if effective_counted < 0 then raise exception 'Effective counted quantity cannot be negative'; end if;
  select id into hr_warehouse_id from public.warehouses where purpose = 'HR' and is_active order by id limit 1;
  select id into general_warehouse_id from public.warehouses where purpose = 'GENERAL' and is_active order by id limit 1;
  if hr_warehouse_id is null or general_warehouse_id is null then raise exception 'Both active HR and GENERAL warehouses are required'; end if;
  insert into public.inventory_balances(warehouse_id,item_id) values (hr_warehouse_id,correction_line.item_id),(general_warehouse_id,correction_line.item_id) on conflict do nothing;
  perform 1 from public.inventory_balances b where b.item_id = correction_line.item_id and b.warehouse_id in (hr_warehouse_id,general_warehouse_id) order by b.warehouse_id for update;
  select * into balance_row from public.inventory_balances where warehouse_id = stocktake_row.warehouse_id and item_id = correction_line.item_id;
  if correction_line.counted_quantity_delta < 0 and balance_row.on_hand_quantity < -correction_line.counted_quantity_delta then raise exception 'Stocktake correction would make the counted warehouse negative'; end if;
  select coalesce(array_agg(x.source_hr_request_id order by x.source_hr_request_id), '{}'::uuid[]) into affected_request_ids
  from (select distinct source_hr_request_id from public.inventory_reservations where item_id = correction_line.item_id and status = 'ACTIVE') x;
  for request_id_row in select request_id from unnest(affected_request_ids) requested(request_id) order by request_id loop perform pg_advisory_xact_lock(hashtext(request_id_row.request_id::text)); end loop;
  perform 1 from public.inventory_reservations r where r.item_id = correction_line.item_id and r.status = 'ACTIVE' order by r.source_hr_request_id,r.id for update;
  select coalesce(sum(b.on_hand_quantity),0) + correction_line.counted_quantity_delta into combined_on_hand from public.inventory_balances b where b.item_id = correction_line.item_id and b.warehouse_id in (hr_warehouse_id,general_warehouse_id);
  select coalesce(sum(r.quantity),0) into active_reserved from public.inventory_reservations r where r.item_id = correction_line.item_id and r.status = 'ACTIVE';
  if combined_on_hand < active_reserved then
    select coalesce(array_agg(x.source_hr_request_id order by x.source_hr_request_id),'{}'::uuid[]) into affected_request_ids from (select distinct source_hr_request_id from public.inventory_reservations where item_id = correction_line.item_id and status = 'ACTIVE') x;
    for request_id_row in select request_id from unnest(affected_request_ids) requested(request_id) order by request_id loop perform pg_advisory_xact_lock(hashtext(request_id_row.request_id::text)); end loop;
    for item_id_row in select distinct r.item_id from public.inventory_reservations r where r.source_hr_request_id = any(affected_request_ids) and r.status = 'ACTIVE' union select correction_line.item_id order by item_id loop insert into public.inventory_item_locks(item_id) values (item_id_row.item_id) on conflict do nothing; perform 1 from public.inventory_item_locks where item_id = item_id_row.item_id for update; end loop;
    for request_id_row in select request_id from unnest(affected_request_ids) requested(request_id) order by request_id loop perform 1 from public.hr_requests where id = request_id_row.request_id for update; perform 1 from public.inventory_reservations r where r.source_hr_request_id = request_id_row.request_id order by r.item_id,r.id for update; end loop;
    update public.inventory_reservations set status = 'CONFLICTED', closed_at = coalesce(closed_at,now()) where source_hr_request_id = any(affected_request_ids) and status = 'ACTIVE';
    update public.hr_requests set status = 'INVENTORY_REVIEW_REQUIRED', row_version = row_version + 1 where id = any(affected_request_ids) and status = 'SUBMITTED';
  end if;
  insert into public.inventory_postings(idempotency_key,posting_kind,source_entity_id,posted_by) values (p_idempotency_key,'CORRECTION',p_correction_note_id,current_account) returning id into posting_id;
  insert into public.correction_posting_sources(posting_id,correction_note_id) values (posting_id,p_correction_note_id);
  insert into public.inventory_ledger_entries(posting_id,line_no,warehouse_id,item_id,movement_kind,quantity_delta,occurred_on) values (posting_id,1,stocktake_row.warehouse_id,correction_line.item_id,'STOCKTAKE_CORRECTION',correction_line.counted_quantity_delta,current_date);
  update public.inventory_balances set on_hand_quantity = on_hand_quantity + correction_line.counted_quantity_delta, version = version + 1, last_posting_id = posting_id, updated_at = now() where warehouse_id = stocktake_row.warehouse_id and item_id = correction_line.item_id;
  update public.correction_notes set status = 'POSTED',posted_at = now(),posted_by = current_account where id = p_correction_note_id returning * into correction_row;
  update public.operation_commands set status = 'SUCCEEDED',result_entity_type = 'correction_notes',result_entity_id = p_correction_note_id,succeeded_at = now() where id = command_row.id;
  return correction_row;
end;
$$;

create or replace function public.get_stocktake_correction_status(p_correction_note_id uuid default null,p_create_idempotency_key text default null,p_post_idempotency_key text default null)
returns public.correction_notes language plpgsql security definer set search_path = pg_catalog, private
as $$
declare current_account uuid; correction_id uuid := p_correction_note_id; correction_row public.correction_notes;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role','') <> 'authenticated' or current_account is null then raise exception using errcode = '42501', message = 'An authenticated app account is required'; end if;
  if correction_id is null and btrim(coalesce(p_create_idempotency_key,'')) <> '' then select result_entity_id into correction_id from public.operation_commands where operation_code = 'CREATE_STOCKTAKE_CORRECTION' and idempotency_key = p_create_idempotency_key and actor_account_id = current_account; end if;
  if correction_id is null and btrim(coalesce(p_post_idempotency_key,'')) <> '' then select result_entity_id into correction_id from public.operation_commands where operation_code = 'POST_STOCKTAKE_CORRECTION' and idempotency_key = p_post_idempotency_key and actor_account_id = current_account; end if;
  if correction_id is null then return null; end if;
  select * into correction_row from public.correction_notes where id = correction_id and created_by = current_account and correction_kind = 'STOCKTAKE';
  return correction_row;
end;
$$;

revoke all on function public.create_stocktake_correction_draft(text, uuid, bigint, text, text, text, text) from public, anon;
revoke all on function public.post_stocktake_correction(uuid, text, text) from public, anon;
revoke all on function public.get_stocktake_correction_status(uuid, text, text) from public, anon;
grant execute on function public.create_stocktake_correction_draft(text, uuid, bigint, text, text, text, text) to authenticated;
grant execute on function public.post_stocktake_correction(uuid, text, text) to authenticated;
grant execute on function public.get_stocktake_correction_status(uuid, text, text) to authenticated;
