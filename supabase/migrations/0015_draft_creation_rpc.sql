-- Atomic draft creation for the first operational UI path.

create or replace function public.create_hr_request_draft(
  p_request_no text,
  p_distribution_date date,
  p_note text,
  p_issue_lines jsonb,
  p_increase_lines jsonb,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.hr_requests
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  request_row public.hr_requests;
  line_value jsonb;
  employee_row record;
  item_row record;
  line_no integer := 0;
  quantity bigint;
  issue_count integer := 0;
  increase_count integer := 0;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('HR') then
    raise exception using errcode = '42501', message = 'HR role is required';
  end if;
  if btrim(coalesce(p_request_no, '')) = '' or p_distribution_date is null
     or jsonb_typeof(p_issue_lines) <> 'array' or jsonb_typeof(p_increase_lines) <> 'array'
     or jsonb_array_length(p_issue_lines) > 1000 or jsonb_array_length(p_increase_lines) > 1000
     or pg_column_size(p_issue_lines) + pg_column_size(p_increase_lines) > 10000000
     or btrim(coalesce(p_idempotency_key, '')) = '' or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'HR draft fields are invalid';
  end if;
  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('CREATE_HR_REQUEST_DRAFT', p_idempotency_key, p_request_fingerprint, current_account)
  on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'CREATE_HR_REQUEST_DRAFT' and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' and command_row.result_entity_id is not null then
      select * into request_row from public.hr_requests where id = command_row.result_entity_id;
      return request_row;
    end if;
    raise exception using errcode = '40001', message = 'HR draft is already in progress or failed';
  end if;
  insert into public.hr_requests (request_no, distribution_date, note, created_by)
  values (left(btrim(p_request_no), 80), p_distribution_date, left(nullif(btrim(coalesce(p_note, '')), ''), 2000), current_account)
  returning * into request_row;

  for line_value in select value from jsonb_array_elements(p_issue_lines) loop
    if jsonb_typeof(line_value) <> 'object'
       or btrim(coalesce(line_value ->> 'employeeId', '')) = ''
       or btrim(coalesce(line_value ->> 'itemId', '')) = ''
       or coalesce(line_value ->> 'quantity', '') !~ '^[1-9][0-9]{0,17}$' then
      raise exception 'Invalid HR issue line';
    end if;
    quantity := (line_value ->> 'quantity')::bigint;
    select e.id, e.employee_no, e.name, e.institution_id, i.code as institution_code, i.name as institution_name,
           e.department_id, d.code as department_code, d.name as department_name
      into employee_row
      from public.employees e
      join public.institutions i on i.id = e.institution_id
      join public.departments d on d.id = e.department_id and d.institution_id = e.institution_id
     where e.id = (line_value ->> 'employeeId')::uuid and e.employment_status = 'ACTIVE' and i.is_active and d.is_active;
    if employee_row.id is null then raise exception 'Active employee does not exist'; end if;
    select id, item_code, item_name, unit, size into item_row
      from public.uniform_items
     where id = (line_value ->> 'itemId')::uuid and is_active;
    if item_row.id is null then raise exception 'Active uniform item does not exist'; end if;
    line_no := line_no + 1;
    insert into public.hr_issue_lines (
      request_id, employee_id, item_id, line_no, quantity,
      employee_no_snapshot, employee_name_snapshot, institution_id_snapshot,
      institution_code_snapshot, institution_name_snapshot, department_id_snapshot,
      department_code_snapshot, department_name_snapshot, item_code_snapshot,
      item_name_snapshot, unit_snapshot, size_snapshot
    ) values (
      request_row.id, employee_row.id, item_row.id, line_no, quantity,
      employee_row.employee_no, employee_row.name, employee_row.institution_id,
      employee_row.institution_code, employee_row.institution_name, employee_row.department_id,
      employee_row.department_code, employee_row.department_name, item_row.item_code,
      item_row.item_name, item_row.unit, item_row.size
    );
    insert into public.hr_request_items (request_id, item_id, issue_quantity, increase_quantity, item_code_snapshot, item_name_snapshot, unit_snapshot)
    values (request_row.id, item_row.id, quantity, 0, item_row.item_code, item_row.item_name, item_row.unit)
    on conflict (request_id, item_id) do update
      set issue_quantity = public.hr_request_items.issue_quantity + excluded.issue_quantity;
    issue_count := issue_count + 1;
  end loop;

  for line_value in select value from jsonb_array_elements(p_increase_lines) loop
    if jsonb_typeof(line_value) <> 'object'
       or btrim(coalesce(line_value ->> 'itemId', '')) = ''
       or coalesce(line_value ->> 'quantity', '') !~ '^[0-9][0-9]{0,17}$' then
      raise exception 'Invalid HR increase line';
    end if;
    quantity := (line_value ->> 'quantity')::bigint;
    if quantity = 0 then continue; end if;
    select id, item_code, item_name, unit into item_row
      from public.uniform_items
     where id = (line_value ->> 'itemId')::uuid and is_active;
    if item_row.id is null then raise exception 'Active uniform item does not exist'; end if;
    insert into public.hr_request_items (request_id, item_id, issue_quantity, increase_quantity, item_code_snapshot, item_name_snapshot, unit_snapshot)
    values (request_row.id, item_row.id, 0, quantity, item_row.item_code, item_row.item_name, item_row.unit)
    on conflict (request_id, item_id) do update
      set increase_quantity = public.hr_request_items.increase_quantity + excluded.increase_quantity;
    increase_count := increase_count + 1;
  end loop;
  if issue_count = 0 and increase_count = 0 then raise exception 'HR draft needs an issue or increase line'; end if;

  update public.operation_commands
     set status = 'SUCCEEDED', result_entity_type = 'hr_requests', result_entity_id = request_row.id, succeeded_at = now()
   where id = command_row.id;
  return request_row;
end;
$$;

create or replace function public.create_replenishment_draft(
  p_request_no text,
  p_note text,
  p_lines jsonb,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.replenishment_requests
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  request_row public.replenishment_requests;
  line_value jsonb;
  item_row record;
  quantity bigint;
  line_count integer := 0;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('HR') then
    raise exception using errcode = '42501', message = 'HR role is required';
  end if;
  if btrim(coalesce(p_request_no, '')) = '' or jsonb_typeof(p_lines) <> 'array'
     or jsonb_array_length(p_lines) = 0 or jsonb_array_length(p_lines) > 1000
     or pg_column_size(p_lines) > 10000000
     or btrim(coalesce(p_idempotency_key, '')) = '' or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'Replenishment draft fields are invalid';
  end if;
  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('CREATE_REPLENISHMENT_DRAFT', p_idempotency_key, p_request_fingerprint, current_account)
  on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'CREATE_REPLENISHMENT_DRAFT' and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' and command_row.result_entity_id is not null then
      select * into request_row from public.replenishment_requests where id = command_row.result_entity_id;
      return request_row;
    end if;
    raise exception using errcode = '40001', message = 'Replenishment draft is already in progress or failed';
  end if;
  insert into public.replenishment_requests (request_no, note, created_by)
  values (left(btrim(p_request_no), 80), left(nullif(btrim(coalesce(p_note, '')), ''), 2000), current_account)
  returning * into request_row;
  for line_value in select value from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(line_value) <> 'object' or btrim(coalesce(line_value ->> 'itemId', '')) = ''
       or coalesce(line_value ->> 'quantity', '') !~ '^[1-9][0-9]{0,17}$' then
      raise exception 'Invalid replenishment line';
    end if;
    quantity := (line_value ->> 'quantity')::bigint;
    select id, item_code, item_name, unit into item_row from public.uniform_items
     where id = (line_value ->> 'itemId')::uuid and is_active;
    if item_row.id is null then raise exception 'Active uniform item does not exist'; end if;
    insert into public.replenishment_request_lines (request_id, item_id, requested_quantity, item_code_snapshot, item_name_snapshot, unit_snapshot)
    values (request_row.id, item_row.id, quantity, item_row.item_code, item_row.item_name, item_row.unit);
    line_count := line_count + 1;
  end loop;
  if line_count = 0 then raise exception 'Replenishment draft needs a line'; end if;
  update public.operation_commands set status = 'SUCCEEDED', result_entity_type = 'replenishment_requests', result_entity_id = request_row.id, succeeded_at = now() where id = command_row.id;
  return request_row;
end;
$$;

create or replace function public.create_warehouse_shipment_draft(
  p_shipment_no text,
  p_hr_request_id uuid,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.warehouse_shipments
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  request_row public.hr_requests;
  shipment_row public.warehouse_shipments;
  item_row record;
  general_warehouse_id uuid;
  general_on_hand bigint;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('WAREHOUSE') then
    raise exception using errcode = '42501', message = 'WAREHOUSE role is required';
  end if;
  if btrim(coalesce(p_shipment_no, '')) = '' or p_hr_request_id is null
     or btrim(coalesce(p_idempotency_key, '')) = '' or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'Shipment draft fields are invalid';
  end if;
  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('CREATE_WAREHOUSE_SHIPMENT_DRAFT', p_idempotency_key, p_request_fingerprint, current_account)
  on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'CREATE_WAREHOUSE_SHIPMENT_DRAFT' and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' and command_row.result_entity_id is not null then
      select * into shipment_row from public.warehouse_shipments where id = command_row.result_entity_id;
      return shipment_row;
    end if;
    raise exception using errcode = '40001', message = 'Shipment draft is already in progress or failed';
  end if;
  select * into request_row from public.hr_requests where id = p_hr_request_id for update;
  if request_row.id is null or request_row.status <> 'SUBMITTED' then raise exception 'Only SUBMITTED HR requests can be shipped'; end if;
  select id into general_warehouse_id from public.warehouses where purpose = 'GENERAL' and is_active;
  if general_warehouse_id is null then raise exception 'Active GENERAL warehouse is required'; end if;
  insert into public.warehouse_shipments (shipment_no, hr_request_id, created_by, source_request_row_version)
  values (left(btrim(p_shipment_no), 80), request_row.id, current_account, request_row.row_version)
  returning * into shipment_row;
  for item_row in
    select r.id as request_item_id, r.item_id, r.requested_transfer_quantity, r.item_code_snapshot, r.item_name_snapshot, r.unit_snapshot
    from public.hr_request_items r where r.request_id = request_row.id order by r.item_id
  loop
    select coalesce((select b.on_hand_quantity from public.inventory_balances b
      where b.warehouse_id = general_warehouse_id and b.item_id = item_row.item_id), 0)
      into general_on_hand;
    insert into public.warehouse_shipment_lines (
      shipment_id, hr_request_id, hr_request_item_id, item_id,
      requested_transfer_quantity_snapshot, general_on_hand_snapshot,
      maximum_transfer_quantity_snapshot, actual_transfer_quantity
    ) values (
      shipment_row.id, request_row.id, item_row.request_item_id, item_row.item_id,
      item_row.requested_transfer_quantity, general_on_hand,
      least(item_row.requested_transfer_quantity, general_on_hand),
      least(item_row.requested_transfer_quantity, general_on_hand)
    );
  end loop;
  update public.operation_commands set status = 'SUCCEEDED', result_entity_type = 'warehouse_shipments', result_entity_id = shipment_row.id, succeeded_at = now() where id = command_row.id;
  return shipment_row;
end;
$$;

revoke all on function public.create_hr_request_draft(text, date, text, jsonb, jsonb, text, text) from public, anon;
revoke all on function public.create_replenishment_draft(text, text, jsonb, text, text) from public, anon;
revoke all on function public.create_warehouse_shipment_draft(text, uuid, text, text) from public, anon;
grant execute on function public.create_hr_request_draft(text, date, text, jsonb, jsonb, text, text) to authenticated;
grant execute on function public.create_replenishment_draft(text, text, jsonb, text, text) to authenticated;
grant execute on function public.create_warehouse_shipment_draft(text, uuid, text, text) to authenticated;
