-- Once-only opening balance cutover gate and immutable opening posting.

create table public.system_cutover_state (
  id smallint primary key check (id = 1),
  status text not null check (status in ('PRE_CUTOVER', 'LIVE')),
  opening_import_batch_id uuid,
  opening_posting_id uuid,
  cutover_at timestamptz,
  cutover_by uuid references public.app_accounts(id)
);
insert into public.system_cutover_state (id, status) values (1, 'PRE_CUTOVER');

create table public.opening_balance_batches (
  id uuid primary key default gen_random_uuid(),
  batch_no text not null unique check (btrim(batch_no) <> ''),
  status text not null default 'PREPARING' check (status in ('PREPARING', 'VALIDATED', 'APPLIED', 'FAILED')),
  source_filename text,
  source_hash text,
  row_count integer not null default 0 check (row_count >= 0),
  error_count integer not null default 0 check (error_count >= 0),
  created_by uuid not null references public.app_accounts(id),
  applied_at timestamptz,
  applied_by uuid references public.app_accounts(id),
  error_message text
);

create table public.opening_balance_rows (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.opening_balance_batches(id),
  row_number integer not null check (row_number > 1),
  warehouse_code text not null,
  item_code text not null,
  quantity bigint not null,
  status text not null default 'VALIDATED' check (status in ('VALIDATED', 'ERROR')),
  error_code text,
  error_message text,
  unique (batch_id, row_number)
);

create table public.opening_posting_sources (
  posting_id uuid primary key references public.inventory_postings(id),
  batch_id uuid not null unique references public.opening_balance_batches(id)
);

alter table public.system_cutover_state enable row level security;
alter table public.opening_balance_batches enable row level security;
alter table public.opening_balance_rows enable row level security;
create policy cutover_state_read on public.system_cutover_state
  for select to authenticated using (private.has_role('SYSTEM_ADMIN') or private.has_role('HR'));
create policy opening_batch_read on public.opening_balance_batches
  for select to authenticated using (private.has_role('SYSTEM_ADMIN') or private.has_role('HR'));
create policy opening_rows_read on public.opening_balance_rows
  for select to authenticated using (private.has_role('SYSTEM_ADMIN') or private.has_role('HR'));
revoke all on table public.system_cutover_state, public.opening_balance_batches, public.opening_balance_rows,
  public.opening_posting_sources from public, anon, authenticated;
grant select on public.system_cutover_state, public.opening_balance_batches, public.opening_balance_rows to authenticated;

create or replace function private.require_live_cutover_for_posting()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  cutover_status text;
begin
  select status into cutover_status from public.system_cutover_state where id = 1 for share;
  if new.posting_kind <> 'OPENING' and cutover_status <> 'LIVE' then
    raise exception using errcode = '55000', message = 'System cutover is not LIVE; only opening balance posting is allowed';
  end if;
  if new.posting_kind = 'OPENING' and cutover_status <> 'PRE_CUTOVER' then
    raise exception using errcode = '55000', message = 'Opening balance can only be posted during PRE_CUTOVER';
  end if;
  return new;
end;
$$;
create trigger inventory_posting_cutover_gate
before insert on public.inventory_postings
for each row execute function private.require_live_cutover_for_posting();

create or replace function public.create_opening_balance_batch(
  p_source_filename text,
  p_rows jsonb,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.opening_balance_batches
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  batch_row public.opening_balance_batches;
  row_value jsonb;
  row_no integer := 1;
  error_count integer := 0;
  row_count integer := 0;
  warehouse_code text;
  item_code text;
  quantity bigint;
  error_code text;
  error_message text;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('SYSTEM_ADMIN') then
    raise exception using errcode = '42501', message = 'SYSTEM_ADMIN role is required';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'Opening rows must be a non-empty JSON array'; end if;
  if btrim(coalesce(p_idempotency_key, '')) = '' or btrim(coalesce(p_request_fingerprint, '')) = '' then raise exception 'idempotency_key and request_fingerprint are required'; end if;
  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('CREATE_OPENING_BALANCE_BATCH', p_idempotency_key, p_request_fingerprint, current_account)
  on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'CREATE_OPENING_BALANCE_BATCH' and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account or command_row.canonical_request_fingerprint <> p_request_fingerprint then raise exception using errcode = '40001', message = 'idempotency key conflicts with another request'; end if;
    if command_row.status = 'SUCCEEDED' then select * into batch_row from public.opening_balance_batches where id = command_row.result_entity_id; return batch_row; end if;
    raise exception using errcode = '40001', message = 'Opening batch is already in progress or failed';
  end if;
  if exists (select 1 from public.system_cutover_state where id = 1 and status <> 'PRE_CUTOVER') then raise exception 'System is already LIVE'; end if;
  insert into public.opening_balance_batches (batch_no, source_filename, created_by)
  values ('OPEN-' || substring(gen_random_uuid()::text from 1 for 12), left(nullif(btrim(p_source_filename), ''), 255), current_account)
  returning * into batch_row;
  for row_value in select value from jsonb_array_elements(p_rows) loop
    row_no := row_no + 1; row_count := row_count + 1; error_code := null; error_message := null;
    warehouse_code := btrim(coalesce(row_value ->> 'warehouseCode', ''));
    item_code := btrim(coalesce(row_value ->> 'itemCode', ''));
    quantity := null;
    if coalesce(row_value ->> 'quantity', '') ~ '^[0-9]{1,18}$' then
      quantity := (row_value ->> 'quantity')::bigint;
    end if;
    if warehouse_code = '' or item_code = '' or quantity is null or quantity < 0 then
      error_code := 'INVALID_ROW'; error_message := '倉庫代碼、品號與非負數量為必要欄位'; error_count := error_count + 1;
    end if;
    insert into public.opening_balance_rows (
      batch_id, row_number, warehouse_code, item_code, quantity, status, error_code, error_message
    ) values (
      batch_row.id, row_no, warehouse_code, item_code, coalesce(quantity, 0),
      case when error_code is null then 'VALIDATED' else 'ERROR' end, error_code, error_message
    );
  end loop;
  update public.opening_balance_batches
  set row_count = row_count, error_count = error_count,
      status = case when error_count = 0 then 'VALIDATED' else 'FAILED' end,
      error_message = case when error_count = 0 then null else 'Opening batch contains validation errors' end
  where id = batch_row.id returning * into batch_row;
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'opening_balance_batches', result_entity_id = batch_row.id, succeeded_at = now()
  where id = command_row.id;
  return batch_row;
end;
$$;

create or replace function public.publish_opening_balance(
  p_batch_id uuid,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.opening_balance_batches
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  batch_row public.opening_balance_batches;
  state_row public.system_cutover_state;
  row_value record;
  warehouse_row public.warehouses;
  item_row public.uniform_items;
  posting_id uuid;
  line_no integer := 0;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('SYSTEM_ADMIN') then
    raise exception using errcode = '42501', message = 'SYSTEM_ADMIN role is required';
  end if;
  if btrim(coalesce(p_idempotency_key, '')) = '' or btrim(coalesce(p_request_fingerprint, '')) = '' then raise exception 'idempotency_key and request_fingerprint are required'; end if;
  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('PUBLISH_OPENING_BALANCE', p_idempotency_key, p_request_fingerprint, current_account)
  on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'PUBLISH_OPENING_BALANCE' and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account or command_row.canonical_request_fingerprint <> p_request_fingerprint then raise exception using errcode = '40001', message = 'idempotency key conflicts with another request'; end if;
    if command_row.status = 'SUCCEEDED' then select * into batch_row from public.opening_balance_batches where id = command_row.result_entity_id; return batch_row; end if;
    raise exception using errcode = '40001', message = 'Opening publish is already in progress or failed';
  end if;
  select * into state_row from public.system_cutover_state where id = 1 for update;
  if state_row.status <> 'PRE_CUTOVER' or state_row.opening_posting_id is not null then raise exception 'Opening balance has already been published'; end if;
  select * into batch_row from public.opening_balance_batches where id = p_batch_id for update;
  if batch_row.id is null or batch_row.status <> 'VALIDATED' then raise exception 'Only VALIDATED opening batches can be published'; end if;
  if exists (select 1 from public.inventory_postings where posting_kind <> 'OPENING') then raise exception 'Non-opening inventory postings already exist'; end if;
  for row_value in
    select r.*, w.id as warehouse_id, i.id as item_id
    from public.opening_balance_rows r
    join public.warehouses w on w.code = r.warehouse_code and w.is_active
    join public.uniform_items i on i.item_code = r.item_code and i.is_active
    where r.batch_id = p_batch_id and r.status = 'VALIDATED'
    order by w.id, i.id for update
  loop
    null;
  end loop;
  if exists (
    select 1 from public.opening_balance_rows r
    left join public.warehouses w on w.code = r.warehouse_code and w.is_active
    left join public.uniform_items i on i.item_code = r.item_code and i.is_active
    where r.batch_id = p_batch_id and (w.id is null or i.id is null)
  ) then raise exception 'Opening batch references missing or inactive warehouse/item'; end if;
  insert into public.inventory_postings (idempotency_key, posting_kind, source_entity_id, posted_by)
  values (p_idempotency_key, 'OPENING', p_batch_id, current_account) returning id into posting_id;
  insert into public.opening_posting_sources (posting_id, batch_id) values (posting_id, p_batch_id);
  for row_value in
    select w.id as warehouse_id, i.id as item_id, r.quantity
    from public.opening_balance_rows r
    join public.warehouses w on w.code = r.warehouse_code and w.is_active
    join public.uniform_items i on i.item_code = r.item_code and i.is_active
    where r.batch_id = p_batch_id order by w.id, i.id
  loop
    line_no := line_no + 1;
    insert into public.inventory_ledger_entries (posting_id, line_no, warehouse_id, item_id, movement_kind, quantity_delta, occurred_on)
    values (posting_id, line_no, row_value.warehouse_id, row_value.item_id, 'OPENING_BALANCE', row_value.quantity, current_date);
    insert into public.inventory_balances (warehouse_id, item_id, on_hand_quantity, version, last_posting_id)
    values (row_value.warehouse_id, row_value.item_id, row_value.quantity, 1, posting_id)
    on conflict (warehouse_id, item_id) do update set on_hand_quantity = excluded.on_hand_quantity,
      version = inventory_balances.version + 1, last_posting_id = posting_id, updated_at = now();
  end loop;
  update public.opening_balance_batches set status = 'APPLIED', applied_at = now(), applied_by = current_account where id = p_batch_id returning * into batch_row;
  update public.system_cutover_state set status = 'LIVE', opening_import_batch_id = p_batch_id, opening_posting_id = posting_id, cutover_at = now(), cutover_by = current_account where id = 1;
  update public.operation_commands set status = 'SUCCEEDED', result_entity_type = 'opening_balance_batches', result_entity_id = p_batch_id, succeeded_at = now() where id = command_row.id;
  return batch_row;
end;
$$;

revoke all on function public.create_opening_balance_batch(text, jsonb, text, text) from public, anon;
revoke all on function public.publish_opening_balance(uuid, text, text) from public, anon;
grant execute on function public.create_opening_balance_batch(text, jsonb, text, text) to authenticated;
grant execute on function public.publish_opening_balance(uuid, text, text) to authenticated;
