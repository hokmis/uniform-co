begin;

-- SYSTEM_ADMIN is the master-data owner in the domain contract. The original
-- 0014 function only admitted HR (or PROCUREMENT for supplier entities), which
-- made an authenticated SYSTEM_ADMIN receive "Role cannot manage this master data".
-- Keep the existing validation, idempotency, locking and atomic upsert behavior;
-- only widen the master-data manager role and align the read/export surface.
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
  if not (private.has_role('SYSTEM_ADMIN') or private.has_role('HR') or (private.has_role('PROCUREMENT') and entity_type in ('SUPPLIERS', 'SUPPLIER_ITEMS'))) then
    raise exception using errcode = '42501', message = 'Role cannot manage this master data';
  end if;
  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('APPLY_MASTER_IMPORT_' || entity_type, p_idempotency_key, p_request_fingerprint, current_account)
  on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'APPLY_MASTER_IMPORT_' || entity_type and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account or command_row.canonical_request_fingerprint <> p_request_fingerprint then raise exception using errcode = '40001', message = 'idempotency key conflicts with another request'; end if;
    if command_row.status = 'SUCCEEDED' then select * into batch_row from public.master_import_batches where id = command_row.result_entity_id; return batch_row; end if;
    if command_row.status in ('RETRYABLE_FAILED', 'TERMINAL_FAILED') and command_row.result_entity_id is not null then
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
      if error_code is null and not exists (select 1 from public.institutions i where i.code = institution_code and i.is_active) then error_code := 'INSTITUTION_NOT_FOUND'; error_message := '機構不存在或已停用'; end if;
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
      if error_code is null and not exists (select 1 from public.suppliers s where s.supplier_code = supplier_code and s.is_active) then error_code := 'SUPPLIER_NOT_FOUND'; error_message := '供應商不存在或已停用'; end if;
      if error_code is null and not exists (select 1 from public.uniform_items i where i.item_code = item_code and i.is_active) then error_code := 'ITEM_NOT_FOUND'; error_message := '制服品號不存在或已停用'; end if;
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
      select to_jsonb(i) into old_values from public.institutions i where i.code = change_key for update;
      insert into public.master_import_changes (batch_id, actor_account_id, entity_type, entity_key, action, old_values, new_values)
      values (batch_row.id, current_account, entity_type, change_key, case when old_values is null then 'INSERT' else 'UPDATE' end, old_values, row_value);
      insert into public.institutions as target (code, name, is_active) values (change_key, btrim(row_value ->> 'name'), coalesce((row_value ->> 'isActive')::boolean, true))
      on conflict (code) do update set name = excluded.name, is_active = coalesce((row_value ->> 'isActive')::boolean, target.is_active);
    elsif entity_type = 'DEPARTMENTS' then
      select id into target_id from public.institutions where code = btrim(row_value ->> 'institutionCode');
      change_key := btrim(row_value ->> 'institutionCode') || ':' || btrim(row_value ->> 'code');
      select to_jsonb(d) into old_values from public.departments d where d.institution_id = target_id and d.code = btrim(row_value ->> 'code') for update;
      insert into public.master_import_changes (batch_id, actor_account_id, entity_type, entity_key, action, old_values, new_values)
      values (batch_row.id, current_account, entity_type, change_key, case when old_values is null then 'INSERT' else 'UPDATE' end, old_values, row_value);
      insert into public.departments as target (institution_id, code, name, is_active) values (target_id, btrim(row_value ->> 'code'), btrim(row_value ->> 'name'), coalesce((row_value ->> 'isActive')::boolean, true))
      on conflict (institution_id, code) do update set name = excluded.name, is_active = coalesce((row_value ->> 'isActive')::boolean, target.is_active);
    elsif entity_type = 'UNIFORM_ITEMS' then
      change_key := btrim(row_value ->> 'code');
      select to_jsonb(i) into old_values from public.uniform_items i where i.item_code = change_key for update;
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
      select to_jsonb(s) into old_values from public.suppliers s where s.supplier_code = change_key for update;
      insert into public.master_import_changes (batch_id, actor_account_id, entity_type, entity_key, action, old_values, new_values)
      values (batch_row.id, current_account, entity_type, change_key, case when old_values is null then 'INSERT' else 'UPDATE' end, old_values, row_value);
      insert into public.suppliers as target (supplier_code, name, default_currency, is_active) values (change_key, btrim(row_value ->> 'name'), nullif(upper(btrim(row_value ->> 'defaultCurrency')), ''), coalesce((row_value ->> 'isActive')::boolean, true))
      on conflict (supplier_code) do update set name = excluded.name,
        default_currency = case when row_value ? 'defaultCurrency' and btrim(coalesce(row_value ->> 'defaultCurrency', '')) <> '' then excluded.default_currency else target.default_currency end,
        is_active = coalesce((row_value ->> 'isActive')::boolean, target.is_active);
    else
      select id into target_id from public.suppliers where supplier_code = btrim(row_value ->> 'supplierCode');
      select id into item_id_target from public.uniform_items where item_code = btrim(row_value ->> 'itemCode');
      change_key := btrim(row_value ->> 'supplierCode') || ':' || btrim(row_value ->> 'itemCode');
      select to_jsonb(si) into old_values from public.supplier_uniform_items si where si.supplier_id = target_id and si.item_id = item_id_target for update;
      insert into public.master_import_changes (batch_id, actor_account_id, entity_type, entity_key, action, old_values, new_values)
      values (batch_row.id, current_account, entity_type, change_key, case when old_values is null then 'INSERT' else 'UPDATE' end, old_values, row_value);
      insert into public.supplier_uniform_items as target (supplier_id, item_id, minimum_order_quantity, supplier_item_code, is_active) values (target_id, item_id_target, nullif(row_value ->> 'minimumOrderQuantity', '')::bigint, nullif(btrim(row_value ->> 'supplierItemCode'), ''), coalesce((row_value ->> 'isActive')::boolean, true))
      on conflict (supplier_id, item_id) do update set
        minimum_order_quantity = case when row_value ? 'minimumOrderQuantity' and btrim(coalesce(row_value ->> 'minimumOrderQuantity', '')) <> '' then excluded.minimum_order_quantity else target.minimum_order_quantity end,
        supplier_item_code = case when row_value ? 'supplierItemCode' and btrim(coalesce(row_value ->> 'supplierItemCode', '')) <> '' then excluded.supplier_item_code else target.supplier_item_code end,
        is_active = coalesce((row_value ->> 'isActive')::boolean, target.is_active);
    end if;
  end loop;
  insert into public.master_import_events (batch_id, actor_account_id, entity_type, event_type, row_count, error_count)
  values (batch_row.id, current_account, entity_type, 'APPLIED', import_row_count, 0);
  update public.operation_commands set status = 'SUCCEEDED', result_entity_type = 'master_import_batches', result_entity_id = batch_row.id, succeeded_at = now() where id = command_row.id;
  return batch_row;
end;
$$;

-- Keep the idempotent export API used by the product module aligned with the
-- same master-data manager rule.
create or replace function public.export_master_data(
  p_entity_type text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  batch_row public.master_export_batches;
  entity_type text := upper(btrim(coalesce(p_entity_type, '')));
  payload jsonb;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' or current_account is null then
    raise exception using errcode = '42501', message = 'Authenticated account is required';
  end if;
  if entity_type not in ('INSTITUTIONS', 'DEPARTMENTS', 'UNIFORM_ITEMS', 'SUPPLIERS', 'SUPPLIER_ITEMS')
     or btrim(coalesce(p_idempotency_key, '')) = '' or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'Master export fields are invalid';
  end if;
  if not (private.has_role('SYSTEM_ADMIN') or private.has_role('HR') or (private.has_role('PROCUREMENT') and entity_type in ('SUPPLIERS', 'SUPPLIER_ITEMS'))) then
    raise exception using errcode = '42501', message = 'Role cannot export this master data';
  end if;
  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('EXPORT_MASTER_DATA_' || entity_type, p_idempotency_key, p_request_fingerprint, current_account)
  on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'EXPORT_MASTER_DATA_' || entity_type and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' and command_row.result_entity_id is not null then
      select * into batch_row from public.master_export_batches where id = command_row.result_entity_id;
      return jsonb_build_object('batchId', batch_row.id, 'rows', batch_row.payload);
    end if;
    raise exception using errcode = '40001', message = 'Master export is already in progress or failed';
  end if;
  if entity_type = 'INSTITUTIONS' then
    select coalesce(jsonb_agg(jsonb_build_object('code', i.code, 'name', i.name, 'isActive', i.is_active) order by i.code), '[]'::jsonb) into payload from public.institutions i;
  elsif entity_type = 'DEPARTMENTS' then
    select coalesce(jsonb_agg(jsonb_build_object('institutionCode', i.code, 'code', d.code, 'name', d.name, 'isActive', d.is_active) order by i.code, d.code), '[]'::jsonb) into payload
    from public.departments d join public.institutions i on i.id = d.institution_id;
  elsif entity_type = 'UNIFORM_ITEMS' then
    select coalesce(jsonb_agg(jsonb_build_object('code', i.item_code, 'name', i.item_name, 'unit', i.unit, 'size', i.size, 'category', i.category, 'season', i.season, 'isActive', i.is_active) order by i.item_code), '[]'::jsonb) into payload from public.uniform_items i;
  elsif entity_type = 'SUPPLIERS' then
    select coalesce(jsonb_agg(jsonb_build_object('supplierCode', s.supplier_code, 'name', s.name, 'defaultCurrency', btrim(s.default_currency), 'isActive', s.is_active) order by s.supplier_code), '[]'::jsonb) into payload from public.suppliers s;
  else
    select coalesce(jsonb_agg(jsonb_build_object('supplierCode', s.supplier_code, 'itemCode', i.item_code, 'minimumOrderQuantity', si.minimum_order_quantity, 'supplierItemCode', si.supplier_item_code, 'isActive', si.is_active) order by s.supplier_code, i.item_code), '[]'::jsonb) into payload
    from public.supplier_uniform_items si join public.suppliers s on s.id = si.supplier_id join public.uniform_items i on i.id = si.item_id;
  end if;
  insert into public.master_export_batches (entity_type, payload, requested_by)
  values (entity_type, payload, current_account) returning * into batch_row;
  insert into public.master_export_events (batch_id, actor_account_id, event_type) values (batch_row.id, current_account, 'REQUESTED');
  update public.operation_commands set status = 'SUCCEEDED', result_entity_type = 'master_export_batches', result_entity_id = batch_row.id, succeeded_at = now() where id = command_row.id;
  return jsonb_build_object('batchId', batch_row.id, 'rows', payload);
end;
$$;

create or replace function public.record_master_export_download(p_batch_id uuid)
returns public.master_export_batches
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  batch_row public.master_export_batches;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' or current_account is null then
    raise exception using errcode = '42501', message = 'Authenticated account is required';
  end if;
  if not (private.has_role('SYSTEM_ADMIN') or private.has_role('HR') or private.has_role('PROCUREMENT')) then
    raise exception using errcode = '42501', message = 'Role cannot record export download';
  end if;
  select * into batch_row from public.master_export_batches where id = p_batch_id for update;
  if not found then raise exception 'Master export batch not found'; end if;
  if not private.has_role('SYSTEM_ADMIN') and not private.has_role('HR') and batch_row.entity_type not in ('SUPPLIERS', 'SUPPLIER_ITEMS') then
    raise exception using errcode = '42501', message = 'Role cannot record this export download';
  end if;
  insert into public.master_export_events (batch_id, actor_account_id, event_type) values (batch_row.id, current_account, 'DOWNLOADED');
  update public.master_export_batches set downloaded_at = coalesce(downloaded_at, now()), downloaded_by = coalesce(downloaded_by, current_account) where id = batch_row.id returning * into batch_row;
  return batch_row;
end;
$$;

drop policy if exists uniform_items_catalog_read on public.uniform_items;
create policy uniform_items_catalog_read
on public.uniform_items
for select
to authenticated
using (
  private.current_account_id() is not null
  and (
    is_active
    or private.has_role('HR')
    or private.has_role('SYSTEM_ADMIN')
  )
);

drop policy if exists suppliers_authorized_read on public.suppliers;
create policy suppliers_authorized_read
on public.suppliers
for select
to authenticated
using (
  private.has_role('SYSTEM_ADMIN')
  or private.has_role('HR')
  or private.has_role('PROCUREMENT')
  or private.has_role('WAREHOUSE')
  or private.has_role('CEO')
);

drop policy if exists supplier_uniform_items_authorized_read on public.supplier_uniform_items;
create policy supplier_uniform_items_authorized_read
on public.supplier_uniform_items
for select
to authenticated
using (
  private.has_role('SYSTEM_ADMIN')
  or private.has_role('HR')
  or private.has_role('PROCUREMENT')
  or private.has_role('WAREHOUSE')
  or private.has_role('CEO')
);

grant execute on function public.apply_master_import(text, text, jsonb, text, text) to authenticated;
grant execute on function public.export_master_data(text, text, text) to authenticated;
grant execute on function public.record_master_export_download(uuid) to authenticated;

-- SYSTEM_ADMIN is also allowed to review the immutable master-data audit
-- records created by the maintenance and export functions.
drop policy if exists master_import_batches_read on public.master_import_batches;
create policy master_import_batches_read on public.master_import_batches
  for select to authenticated using (private.has_role('SYSTEM_ADMIN') or private.has_role('HR') or private.has_role('PROCUREMENT'));

drop policy if exists master_import_rows_read on public.master_import_rows;
create policy master_import_rows_read on public.master_import_rows
  for select to authenticated using (private.has_role('SYSTEM_ADMIN') or private.has_role('HR') or private.has_role('PROCUREMENT'));

drop policy if exists master_import_events_read on public.master_import_events;
create policy master_import_events_read on public.master_import_events
  for select to authenticated using (private.has_role('SYSTEM_ADMIN') or private.has_role('HR') or private.has_role('PROCUREMENT'));

drop policy if exists master_import_changes_read on public.master_import_changes;
create policy master_import_changes_read on public.master_import_changes
  for select to authenticated using (private.has_role('SYSTEM_ADMIN') or private.has_role('HR') or private.has_role('PROCUREMENT'));

drop policy if exists master_export_batches_read on public.master_export_batches;
create policy master_export_batches_read on public.master_export_batches
  for select to authenticated using (private.has_role('SYSTEM_ADMIN') or private.has_role('HR') or (private.has_role('PROCUREMENT') and entity_type in ('SUPPLIERS', 'SUPPLIER_ITEMS')));

drop policy if exists master_export_events_read on public.master_export_events;
create policy master_export_events_read on public.master_export_events
  for select to authenticated using (private.has_role('SYSTEM_ADMIN') or private.has_role('HR') or (private.has_role('PROCUREMENT') and exists (select 1 from public.master_export_batches b where b.id = batch_id and b.entity_type in ('SUPPLIERS', 'SUPPLIER_ITEMS'))));

-- 0078 grants inactive organization review to HR. Keep that behavior and add
-- the same read capability for the SYSTEM_ADMIN master-data owner.
drop policy if exists institutions_management_read on public.institutions;
create policy institutions_management_read on public.institutions
  for select to authenticated using (private.current_account_id() is not null and (private.has_role('SYSTEM_ADMIN') or private.has_role('HR')));

drop policy if exists departments_management_read on public.departments;
create policy departments_management_read on public.departments
  for select to authenticated using (private.current_account_id() is not null and (private.has_role('SYSTEM_ADMIN') or private.has_role('HR')));

commit;
