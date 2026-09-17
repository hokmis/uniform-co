-- 0081_direct_opening_balance_import.sql
-- Direct, worker-free opening balance import RPC for authenticated users (HR / WAREHOUSE / SYSTEM_ADMIN).
-- Applies opening inventory balances and records ledger entries atomically.

create or replace function public.apply_opening_balance_direct(
  p_source_filename text,
  p_rows jsonb,
  p_idempotency_key text default null,
  p_request_fingerprint text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  cutover_status text;
  idemp_key text;
  posting_id uuid;
  posting_kind_val text;
  line_no integer := 0;
  imported_count integer := 0;
  error_count integer := 0;
  row_item jsonb;
  row_warehouse_code text;
  row_item_code text;
  row_quantity bigint;
  target_warehouse_id uuid;
  target_item_id uuid;
  current_qty bigint;
  delta_qty bigint;
  error_messages text[] := array[]::text[];
begin
  current_account := private.current_account_id();
  if auth.uid() is null
     or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null then
    raise exception using errcode = '42501', message = 'An authenticated app account is required';
  end if;

  if not (private.has_role('SYSTEM_ADMIN') or private.has_role('HR') or private.has_role('WAREHOUSE')) then
    raise exception using errcode = '42501', message = 'HR, WAREHOUSE or SYSTEM_ADMIN role is required';
  end if;

  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception using errcode = '22023', message = 'p_rows must be a non-empty JSON array';
  end if;

  idemp_key := coalesce(nullif(btrim(p_idempotency_key), ''), 'DIRECT-OPENING-' || gen_random_uuid()::text);

  -- Check cutover status
  select status into cutover_status from public.system_cutover_state where id = 1 for share;
  if cutover_status is null then
    cutover_status := 'LIVE';
  end if;

  if cutover_status = 'PRE_CUTOVER' then
    posting_kind_val := 'OPENING';
  else
    posting_kind_val := 'STOCKTAKE';
  end if;

  -- Create posting record
  insert into public.inventory_postings (
    idempotency_key, posting_kind, source_entity_id, posted_by
  ) values (
    idemp_key, posting_kind_val, current_account, current_account
  ) returning id into posting_id;

  -- Process rows
  for row_item in select value from jsonb_array_elements(p_rows) loop
    -- Extract warehouse code (support warehouseCode, warehouse_code, 倉庫代碼)
    row_warehouse_code := btrim(coalesce(
      row_item ->> 'warehouseCode',
      row_item ->> 'warehouse_code',
      row_item ->> 'warehouse',
      row_item ->> '倉庫代碼',
      row_item ->> '倉庫',
      ''
    ));

    -- Extract item code (support itemCode, item_code, 制服品號, 品號)
    row_item_code := btrim(coalesce(
      row_item ->> 'itemCode',
      row_item ->> 'item_code',
      row_item ->> 'item',
      row_item ->> '制服品號',
      row_item ->> '品號',
      ''
    ));

    -- Extract quantity (support quantity, qty, 期初數量, 數量)
    begin
      row_quantity := (coalesce(
        row_item ->> 'quantity',
        row_item ->> 'qty',
        row_item ->> '期初數量',
        row_item ->> '數量',
        '0'
      ))::bigint;
    exception when others then
      row_quantity := -1;
    end;

    if row_quantity < 0 then
      error_count := error_count + 1;
      error_messages := array_append(error_messages, format('品號 %s 數量無效或為負數 (%s)', row_item_code, row_item ->> 'quantity'));
      continue;
    end if;

    -- Lookup warehouse (by code or by purpose)
    select id into target_warehouse_id
    from public.warehouses
    where is_active
      and (upper(code) = upper(row_warehouse_code) or upper(purpose) = upper(row_warehouse_code))
    limit 1;

    if target_warehouse_id is null then
      -- Try default to GENERAL warehouse if not specified
      if row_warehouse_code = '' then
        select id into target_warehouse_id from public.warehouses where is_active and purpose = 'GENERAL' limit 1;
      end if;
      if target_warehouse_id is null then
        error_count := error_count + 1;
        error_messages := array_append(error_messages, format('找不到有效倉庫代碼：%s (品號: %s)', row_warehouse_code, row_item_code));
        continue;
      end if;
    end if;

    -- Lookup uniform item by item_code
    select id into target_item_id
    from public.uniform_items
    where is_active and upper(item_code) = upper(row_item_code)
    limit 1;

    if target_item_id is null then
      error_count := error_count + 1;
      error_messages := array_append(error_messages, format('找不到有效商品品號：%s', row_item_code));
      continue;
    end if;

    -- Query current on hand
    select coalesce(on_hand_quantity, 0) into current_qty
    from public.inventory_balances
    where warehouse_id = target_warehouse_id and item_id = target_item_id;
    if current_qty is null then current_qty := 0; end if;

    delta_qty := row_quantity - current_qty;

    -- Ledger entry
    line_no := line_no + 1;
    insert into public.inventory_ledger_entries (
      posting_id, line_no, warehouse_id, item_id, movement_kind, quantity_delta, occurred_on
    ) values (
      posting_id,
      line_no,
      target_warehouse_id,
      target_item_id,
      case when posting_kind_val = 'OPENING' then 'OPENING_BALANCE' else 'STOCKTAKE' end,
      delta_qty,
      (now() at time zone 'Asia/Taipei')::date
    );

    -- Upsert inventory_balances
    insert into public.inventory_balances (
      warehouse_id, item_id, on_hand_quantity, version, last_posting_id, updated_at
    ) values (
      target_warehouse_id, target_item_id, row_quantity, 1, posting_id, now()
    )
    on conflict (warehouse_id, item_id) do update set
      on_hand_quantity = excluded.on_hand_quantity,
      version = public.inventory_balances.version + 1,
      last_posting_id = posting_id,
      updated_at = now();

    imported_count := imported_count + 1;
  end loop;

  -- If cutover was PRE_CUTOVER, transition to LIVE
  if cutover_status = 'PRE_CUTOVER' then
    update public.system_cutover_state
    set status = 'LIVE',
        opening_posting_id = posting_id,
        cutover_at = now(),
        cutover_by = current_account
    where id = 1;
  end if;

  return jsonb_build_object(
    'success', true,
    'posting_id', posting_id,
    'total_rows', jsonb_array_length(p_rows),
    'imported_rows', imported_count,
    'error_rows', error_count,
    'errors', to_jsonb(error_messages),
    'message', format('已完成期初庫存匯入：成功 %s 筆，略過/異常 %s 筆', imported_count, error_count)
  );
end;
$$;

revoke all on function public.apply_opening_balance_direct(text, jsonb, text, text) from public, anon;
grant execute on function public.apply_opening_balance_direct(text, jsonb, text, text) to authenticated;
