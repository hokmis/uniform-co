begin;

-- Fix apply_master_import for DEPARTMENTS and SUPPLIER_ITEMS to robustly lookup
-- target institution_id / supplier_id using trimmed code matching and order by is_active desc,
-- preventing null value in column institution_id constraint violations.

create or replace function public.apply_master_import(
  p_entity_type text,
  p_source_filename text,
  p_rows jsonb,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.master_import_batches
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  batch_row public.master_import_batches;
  row_value jsonb;
  entity_type text := upper(btrim(coalesce(p_entity_type, '')));
  row_no integer := 1;
  import_row_count integer := 0;
  import_error_count integer := 0;
  code text;
  name text;
  unit text;
  institution_code text;
  department_code text;
  supplier_code text;
  item_code text;
  minimum_order_quantity bigint;
  error_code text;
  error_message text;
  seen_values text[] := '{}'::text[];
  target_id uuid;
  item_id_target uuid;
  lock_key text;
  old_values jsonb;
  change_key text;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' or current_account is null then
    raise exception using errcode = '42501', message = 'Authenticated account is required';
  end if;
  if entity_type not in ('INSTITUTIONS', 'DEPARTMENTS', 'UNIFORM_ITEMS', 'SUPPLIERS', 'SUPPLIER_ITEMS')
     or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0
     or jsonb_array_length(p_rows) > 10000
     or pg_column_size(p_rows) > 10000000
     or btrim(coalesce(p_idempotency_key, '')) = '' or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'Master import fields are invalid';
  end if;
  if not (private.has_role('HR') or (private.has_role('PROCUREMENT') and entity_type in ('SUPPLIERS', 'SUPPLIER_ITEMS'))) then
    raise exception using errcode = '42501', message = 'Role cannot manage this master data';
  end if;
  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('APPLY_MASTER_IMPORT_' || entity_type, p_idempotency_key, p_request_fingerprint, current_account)
  on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'APPLY_MASTER_IMPORT_' || entity_type and idempotency_key = p_idempotency_key;
    if command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'Idempotency key collision with different request payload';
    end if;
    if command_row.status = 'COMPLETED' and command_row.result_entity_type = 'master_import_batches' then
      select * into batch_row from public.master_import_batches where id = command_row.result_entity_id;
      return batch_row;
    end if;
    raise exception using errcode = '40001', message = 'Master import is already in progress or failed';
  end if;
  insert into public.master_import_batches (entity_type, source_filename, created_by)
  values (entity_type, left(nullif(btrim(p_source_filename), ''), 255), current_account)
  returning * into batch_row;
  if entity_type = 'INSTITUTIONS' then
    for lock_key in select distinct btrim(coalesce(value ->> 'code', '')) from jsonb_array_elements(p_rows) value order by 1 loop
      perform pg_advisory_xact_lock(hashtextextended('uniform-master:' || entity_type || ':' || lock_key, 0));
    end loop;
  elsif entity_type = 'DEPARTMENTS' then
    for lock_key in select distinct btrim(coalesce(value ->> 'institutionCode', '')) || ':' || btrim(coalesce(value ->> 'code', '')) from jsonb_array_elements(p_rows) value order by 1 loop
      perform pg_advisory_xact_lock(hashtextextended('uniform-master:' || entity_type || ':' || lock_key, 0));
    end loop;
  elsif entity_type = 'UNIFORM_ITEMS' then
    for lock_key in select distinct btrim(coalesce(value ->> 'code', '')) from jsonb_array_elements(p_rows) value order by 1 loop
      perform pg_advisory_xact_lock(hashtextextended('uniform-master:' || entity_type || ':' || lock_key, 0));
    end loop;
  elsif entity_type = 'SUPPLIERS' then
    for lock_key in select distinct btrim(coalesce(value ->> 'supplierCode', '')) from jsonb_array_elements(p_rows) value order by 1 loop
      perform pg_advisory_xact_lock(hashtextextended('uniform-master:' || entity_type || ':' || lock_key, 0));
    end loop;
  else
    for lock_key in select distinct btrim(coalesce(value ->> 'supplierCode', '')) || ':' || btrim(coalesce(value ->> 'itemCode', '')) from jsonb_array_elements(p_rows) value order by 1 loop
      perform pg_advisory_xact_lock(hashtextextended('uniform-master:' || entity_type || ':' || lock_key, 0));
    end loop;
  end if;
  for row_value in select value from jsonb_array_elements(p_rows) loop
    row_no := row_no + 1; import_row_count := import_row_count + 1; error_code := null; error_message := null;
    code := btrim(coalesce(row_value ->> case when entity_type = 'SUPPLIERS' then 'supplierCode' else 'code' end, ''));
    name := btrim(coalesce(row_value ->> 'name', ''));
    unit := btrim(coalesce(row_value ->> 'unit', ''));
    institution_code := btrim(coalesce(row_value ->> 'institutionCode', ''));
    department_code := btrim(coalesce(row_value ->> 'departmentCode', ''));
    supplier_code := btrim(coalesce(row_value ->> 'supplierCode', ''));
    item_code := btrim(coalesce(row_value ->> 'itemCode', ''));
    minimum_order_quantity := null;
    if coalesce(row_value ->> 'minimumOrderQuantity', '') ~ '^[0-9]{1,18}$' then minimum_order_quantity := (row_value ->> 'minimumOrderQuantity')::bigint; end if;
    if row_value ? 'isActive' and lower(coalesce(row_value ->> 'isActive', '')) not in ('true', 'false') then
      error_code := 'INVALID_BOOLEAN'; error_message := 'isActive 必須是 true 或 false';
    end if;
    if error_code is null and (
      code ~ '^[=+@-]' or name ~ '^[=+@-]' or unit ~ '^[=+@-]' or
      institution_code ~ '^[=+@-]' or department_code ~ '^[=+@-]' or
      supplier_code ~ '^[=+@-]' or item_code ~ '^[=+@-]' or
      btrim(coalesce(row_value ->> 'supplierItemCode', '')) ~ '^[=+@-]' or
      btrim(coalesce(row_value ->> 'defaultCurrency', '')) ~ '^[=+@-]' or
      btrim(coalesce(row_value ->> 'size', '')) ~ '^[=+@-]' or
      position(chr(9) in code) > 0 or position(chr(13) in code) > 0 or
      position(chr(9) in name) > 0 or position(chr(13) in name) > 0 or
      position(chr(9) in unit) > 0 or position(chr(13) in unit) > 0 or
      position(chr(9) in institution_code) > 0 or position(chr(13) in institution_code) > 0 or
      position(chr(9) in department_code) > 0 or position(chr(13) in department_code) > 0 or
      position(chr(9) in supplier_code) > 0 or position(chr(13) in supplier_code) > 0 or
      position(chr(9) in item_code) > 0 or position(chr(13) in item_code) > 0 or
      position(chr(9) in btrim(coalesce(row_value ->> 'supplierItemCode', ''))) > 0 or
      position(chr(13) in btrim(coalesce(row_value ->> 'supplierItemCode', ''))) > 0 or
      position(chr(9) in btrim(coalesce(row_value ->> 'defaultCurrency', ''))) > 0 or
      position(chr(13) in btrim(coalesce(row_value ->> 'defaultCurrency', ''))) > 0 or
      position(chr(9) in btrim(coalesce(row_value ->> 'size', ''))) > 0 or
      position(chr(13) in btrim(coalesce(row_value ->> 'size', ''))) > 0
    ) then
      error_code := 'UNSAFE_TEXT'; error_message := '識別欄與文字欄不可含公式前綴、Tab 或換行';
    end if;
    if entity_type = 'INSTITUTIONS' then
      if code = '' or name = '' then error_code := 'EMPTY_REQUIRED'; error_message := '機構代碼與名稱不可空白'; end if;
      if error_code is null and code = any(seen_values) then error_code := 'DUPLICATE_CODE'; error_message := '批次內機構代碼重複'; end if;
      if error_code is null then seen_values := array_append(seen_values, code); end if;
    elsif entity_type = 'DEPARTMENTS' then
      if institution_code = '' or code = '' or name = '' then error_code := 'EMPTY_REQUIRED'; error_message := '機構代碼、部門代碼與名稱不可空白'; end if;
      if error_code is null and (institution_code || ':' || code) = any(seen_values) then error_code := 'DUPLICATE_CODE'; error_message := '批次內部門代碼重複'; end if;
      if error_code is null and not exists (select 1 from public.institutions i where btrim(i.code) = institution_code and i.is_active) then error_code := 'INSTITUTION_NOT_FOUND'; error_message := '機構不存在或已停用'; end if;
      if error_code is null then seen_values := array_append(seen_values, institution_code || ':' || code); end if;
    elsif entity_type = 'UNIFORM_ITEMS' then
      if code = '' or name = '' or unit = '' then error_code := 'EMPTY_REQUIRED'; error_message := '品號、品名與單位不可空白'; end if;
      if error_code is null and code = any(seen_values) then error_code := 'DUPLICATE_CODE'; error_message := '批次內品號重複'; end if;
      if error_code is null then seen_values := array_append(seen_values, code); end if;
    elsif entity_type = 'SUPPLIERS' then
      if supplier_code = '' or name = '' then error_code := 'EMPTY_REQUIRED'; error_message := '供應商代碼與名稱不可空白'; end if;
      if error_code is null and supplier_code = any(seen_values) then error_code := 'DUPLICATE_CODE'; error_message := '批次內供應商代碼重複'; end if;
      if error_code is null then seen_values := array_append(seen_values, supplier_code); end if;
    else
      if supplier_code = '' or item_code = '' or (row_value ? 'minimumOrderQuantity' and minimum_order_quantity is null) then error_code := 'EMPTY_REQUIRED'; error_message := '供應商代碼、品號與有效 MOQ 不可空白'; end if;
      if error_code is null and not exists (select 1 from public.suppliers s where btrim(s.supplier_code) = supplier_code and s.is_active) then error_code := 'SUPPLIER_NOT_FOUND'; error_message := '供應商不存在或已停用'; end if;
      if error_code is null and not exists (select 1 from public.uniform_items i where btrim(i.item_code) = item_code and i.is_active) then error_code := 'ITEM_NOT_FOUND'; error_message := '制服品號不存在或已停用'; end if;
    end if;
    if jsonb_typeof(row_value) <> 'object' then
      error_code := 'INVALID_ROW'; error_message := '匯入列必須是 JSON 物件';
    elsif jsonb_object_length(row_value) > 50 or exists (select 1 from jsonb_each_text(row_value) field_value where length(field_value.value) > 1000000) then
      error_code := 'CELL_LIMIT'; error_message := '匯入列欄位或儲存格超過安全上限';
    end if;
    if error_code is null then
      insert into public.master_import_rows (batch_id, row_number, raw_values, status) values (batch_row.id, row_no, row_value, 'VALIDATED');
    else
      import_error_count := import_error_count + 1;
      insert into public.master_import_rows (batch_id, row_number, raw_values, status, error_code, error_message) values (batch_row.id, row_no, row_value, 'ERROR', error_code, error_message);
    end if;
  end loop;
  update public.master_import_batches set row_count = import_row_count, error_count = import_error_count, status = case when import_error_count = 0 then 'APPLIED' else 'FAILED' end, completed_at = now(), error_message = case when import_error_count = 0 then null else 'Master import contains validation errors' end where id = batch_row.id returning * into batch_row;
  if import_error_count > 0 then
    insert into public.master_import_events (batch_id, actor_account_id, entity_type, event_type, row_count, error_count)
    values (batch_row.id, current_account, entity_type, 'VALIDATION_FAILED', import_row_count, import_error_count);
    update public.operation_commands set status = 'RETRYABLE_FAILED', result_entity_type = 'master_import_batches', result_entity_id = batch_row.id, last_error_code = 'VALIDATION_FAILED' where id = command_row.id;
    return batch_row;
  end if;
  for row_value in select raw_values from public.master_import_rows where batch_id = batch_row.id order by row_number loop
    if entity_type = 'INSTITUTIONS' then
      change_key := btrim(row_value ->> 'code');
      select to_jsonb(i) into old_values from public.institutions i where btrim(i.code) = change_key for update;
      insert into public.master_import_changes (batch_id, actor_account_id, entity_type, entity_key, action, old_values, new_values)
      values (batch_row.id, current_account, entity_type, change_key, case when old_values is null then 'INSERT' else 'UPDATE' end, old_values, row_value);
      insert into public.institutions as target (code, name, is_active) values (change_key, btrim(row_value ->> 'name'), coalesce((row_value ->> 'isActive')::boolean, true))
      on conflict (code) do update set name = excluded.name, is_active = coalesce((row_value ->> 'isActive')::boolean, target.is_active);
    elsif entity_type = 'DEPARTMENTS' then
      select id into target_id from public.institutions where btrim(code) = btrim(row_value ->> 'institutionCode') order by is_active desc limit 1;
      if target_id is null then
        raise exception using errcode = '40002', message = '找不到所屬機構 (' || btrim(coalesce(row_value ->> 'institutionCode', '')) || ') 的識別碼';
      end if;
      change_key := btrim(row_value ->> 'institutionCode') || ':' || btrim(row_value ->> 'code');
      select to_jsonb(d) into old_values from public.departments d where d.institution_id = target_id and btrim(d.code) = btrim(row_value ->> 'code') for update;
      insert into public.master_import_changes (batch_id, actor_account_id, entity_type, entity_key, action, old_values, new_values)
      values (batch_row.id, current_account, entity_type, change_key, case when old_values is null then 'INSERT' else 'UPDATE' end, old_values, row_value);
      insert into public.departments as target (institution_id, code, name, is_active) values (target_id, btrim(row_value ->> 'code'), btrim(row_value ->> 'name'), coalesce((row_value ->> 'isActive')::boolean, true))
      on conflict (institution_id, code) do update set name = excluded.name, is_active = coalesce((row_value ->> 'isActive')::boolean, target.is_active);
    elsif entity_type = 'UNIFORM_ITEMS' then
      change_key := btrim(row_value ->> 'code');
      select to_jsonb(i) into old_values from public.uniform_items i where btrim(i.item_code) = change_key for update;
      insert into public.master_import_changes (batch_id, actor_account_id, entity_type, entity_key, action, old_values, new_values)
      values (batch_row.id, current_account, entity_type, change_key, case when old_values is null then 'INSERT' else 'UPDATE' end, old_values, row_value);
      insert into public.uniform_items as target (item_code, item_name, unit, size, category, season, is_active) values (change_key, btrim(row_value ->> 'name'), btrim(row_value ->> 'unit'), nullif(btrim(row_value ->> 'size'), ''), nullif(btrim(row_value ->> 'category'), ''), nullif(btrim(row_value ->> 'season'), ''), coalesce((row_value ->> 'isActive')::boolean, true))
      on conflict (item_code) do update set item_name = excluded.item_name, unit = excluded.unit,
        size = case when row_value ? 'size' and btrim(coalesce(row_value ->> 'size', '')) <> '' then excluded.size else target.size end,
        category = case when row_value ? 'category' and btrim(coalesce(row_value ->> 'category', '')) <> '' then excluded.category else target.category end,
        season = case when row_value ? 'season' and btrim(coalesce(row_value ->> 'season', '')) <> '' then excluded.season else target.season end,
        is_active = coalesce((row_value ->> 'isActive')::boolean, target.is_active);
    elsif entity_type = 'SUPPLIERS' then
      change_key := btrim(row_value ->> 'supplierCode');
      select to_jsonb(s) into old_values from public.suppliers s where btrim(s.supplier_code) = change_key for update;
      insert into public.master_import_changes (batch_id, actor_account_id, entity_type, entity_key, action, old_values, new_values)
      values (batch_row.id, current_account, entity_type, change_key, case when old_values is null then 'INSERT' else 'UPDATE' end, old_values, row_value);
      insert into public.suppliers as target (supplier_code, name, is_active) values (change_key, btrim(row_value ->> 'name'), coalesce((row_value ->> 'isActive')::boolean, true))
      on conflict (supplier_code) do update set name = excluded.name, is_active = coalesce((row_value ->> 'isActive')::boolean, target.is_active);
    else
      select id into target_id from public.suppliers where btrim(supplier_code) = btrim(row_value ->> 'supplierCode') order by is_active desc limit 1;
      if target_id is null then
        raise exception using errcode = '40002', message = '找不到對應的供應商 (' || btrim(coalesce(row_value ->> 'supplierCode', '')) || ') 的識別碼';
      end if;
      select id into item_id_target from public.uniform_items where btrim(item_code) = btrim(row_value ->> 'itemCode') order by is_active desc limit 1;
      if item_id_target is null then
        raise exception using errcode = '40002', message = '找不到對應的制服品號 (' || btrim(coalesce(row_value ->> 'itemCode', '')) || ') 的識別碼';
      end if;
      change_key := btrim(row_value ->> 'supplierCode') || ':' || btrim(row_value ->> 'itemCode');
      select to_jsonb(si) into old_values from public.supplier_items si where si.supplier_id = target_id and si.item_id = item_id_target for update;
      insert into public.master_import_changes (batch_id, actor_account_id, entity_type, entity_key, action, old_values, new_values)
      values (batch_row.id, current_account, entity_type, change_key, case when old_values is null then 'INSERT' else 'UPDATE' end, old_values, row_value);
      insert into public.supplier_items as target (supplier_id, item_id, supplier_item_code, minimum_order_quantity, default_currency, is_active)
      values (target_id, item_id_target, nullif(btrim(row_value ->> 'supplierItemCode'), ''), minimum_order_quantity, coalesce(nullif(btrim(row_value ->> 'defaultCurrency'), ''), 'TWD'), coalesce((row_value ->> 'isActive')::boolean, true))
      on conflict (supplier_id, item_id) do update set
        supplier_item_code = case when row_value ? 'supplierItemCode' then excluded.supplier_item_code else target.supplier_item_code end,
        minimum_order_quantity = case when row_value ? 'minimumOrderQuantity' then excluded.minimum_order_quantity else target.minimum_order_quantity end,
        default_currency = case when row_value ? 'defaultCurrency' then excluded.default_currency else target.default_currency end,
        is_active = coalesce((row_value ->> 'isActive')::boolean, target.is_active);
    end if;
  end loop;
  insert into public.master_import_events (batch_id, actor_account_id, entity_type, event_type, row_count, error_count)
  values (batch_row.id, current_account, entity_type, 'APPLIED', import_row_count, 0);
  update public.operation_commands set status = 'COMPLETED', result_entity_type = 'master_import_batches', result_entity_id = batch_row.id, last_error_code = null where id = command_row.id;
  return batch_row;
end;
$$;

commit;
