-- Keep HR request and replenishment drafts editable and cancellable through
-- idempotent, server-side RPCs. Browser DML is intentionally not expanded.

alter table public.hr_requests
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by uuid references public.app_accounts(id),
  add column if not exists cancellation_reason text;

create or replace function public.update_hr_request_draft(
  p_request_id uuid,
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
  item_id_row record;
  item_ids uuid[];
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
  if p_request_id is null or p_distribution_date is null
     or btrim(coalesce(p_idempotency_key, '')) = ''
     or btrim(coalesce(p_request_fingerprint, '')) = ''
     or jsonb_typeof(p_issue_lines) <> 'array'
     or jsonb_typeof(p_increase_lines) <> 'array'
     or jsonb_array_length(p_issue_lines) > 1000
     or jsonb_array_length(p_increase_lines) > 1000
     or pg_column_size(p_issue_lines) + pg_column_size(p_increase_lines) > 10000000 then
    raise exception 'HR draft update fields are invalid';
  end if;

  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('UPDATE_HR_REQUEST_DRAFT', p_idempotency_key, p_request_fingerprint, current_account)
  on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'UPDATE_HR_REQUEST_DRAFT' and idempotency_key = p_idempotency_key
    for update;
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' and command_row.result_entity_id is not null then
      select * into request_row from public.hr_requests where id = command_row.result_entity_id;
      return request_row;
    end if;
    raise exception using errcode = '40001', message = 'HR draft update is already in progress or failed';
  end if;

  -- Match the submit/cancel lock order: operation command -> item mutexes -> request.
  -- Validate UUID-shaped identifiers before casting JSON text to uuid.
  for line_value in select value from jsonb_array_elements(p_issue_lines) loop
    if jsonb_typeof(line_value) <> 'object'
       or btrim(coalesce(line_value ->> 'employeeId', '')) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or btrim(coalesce(line_value ->> 'itemId', '')) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or coalesce(line_value ->> 'quantity', '') !~ '^[1-9][0-9]{0,17}$' then
      raise exception 'Invalid HR issue line';
    end if;
  end loop;
  for line_value in select value from jsonb_array_elements(p_increase_lines) loop
    if jsonb_typeof(line_value) <> 'object'
       or btrim(coalesce(line_value ->> 'itemId', '')) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or coalesce(line_value ->> 'quantity', '') !~ '^[0-9][0-9]{0,17}$' then
      raise exception 'Invalid HR increase line';
    end if;
  end loop;
  select * into request_row from public.hr_requests where id = p_request_id;
  if request_row.id is null then raise exception 'HR request does not exist'; end if;
  if request_row.created_by <> current_account then
    raise exception using errcode = '42501', message = 'Only the request owner can update this draft';
  end if;
  if request_row.status <> 'DRAFT' then raise exception 'Only DRAFT HR requests can be updated'; end if;
  select coalesce(array_agg(item_id order by item_id), '{}'::uuid[])
    into item_ids from (
      select distinct item_id from public.hr_request_items where request_id = p_request_id
      union
      select distinct (value ->> 'itemId')::uuid from jsonb_array_elements(p_issue_lines)
      union
      select distinct (value ->> 'itemId')::uuid from jsonb_array_elements(p_increase_lines)
    ) requested_items;
  insert into public.inventory_item_locks (item_id)
  select item_id from unnest(item_ids) as requested(item_id) order by item_id on conflict (item_id) do nothing;
  for item_id_row in select item_id from unnest(item_ids) as requested(item_id) order by item_id loop
    perform 1 from public.inventory_item_locks where item_id = item_id_row.item_id for update;
  end loop;

  select * into request_row from public.hr_requests where id = p_request_id for update;
  if request_row.id is null then raise exception 'HR request does not exist'; end if;
  if request_row.created_by <> current_account then
    raise exception using errcode = '42501', message = 'Only the request owner can update this draft';
  end if;
  if request_row.status <> 'DRAFT' then raise exception 'Only DRAFT HR requests can be updated'; end if;

  delete from public.hr_issue_lines where request_id = p_request_id;
  delete from public.hr_request_items where request_id = p_request_id;

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
      p_request_id, employee_row.id, item_row.id, line_no, quantity,
      employee_row.employee_no, employee_row.name, employee_row.institution_id,
      employee_row.institution_code, employee_row.institution_name, employee_row.department_id,
      employee_row.department_code, employee_row.department_name, item_row.item_code,
      item_row.item_name, item_row.unit, item_row.size
    );
    insert into public.hr_request_items (request_id, item_id, issue_quantity, increase_quantity, item_code_snapshot, item_name_snapshot, unit_snapshot)
    values (p_request_id, item_row.id, quantity, 0, item_row.item_code, item_row.item_name, item_row.unit)
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
    values (p_request_id, item_row.id, 0, quantity, item_row.item_code, item_row.item_name, item_row.unit)
    on conflict (request_id, item_id) do update
      set increase_quantity = public.hr_request_items.increase_quantity + excluded.increase_quantity;
    increase_count := increase_count + 1;
  end loop;
  if issue_count = 0 and increase_count = 0 then raise exception 'HR draft needs an issue or increase line'; end if;

  update public.hr_requests
     set distribution_date = p_distribution_date,
         note = left(nullif(btrim(coalesce(p_note, '')), ''), 2000),
         row_version = row_version + 1
   where id = p_request_id
   returning * into request_row;
  update public.operation_commands
     set status = 'SUCCEEDED', result_entity_type = 'hr_requests', result_entity_id = request_row.id, succeeded_at = now()
   where id = command_row.id;
  return request_row;
end;
$$;

create or replace function public.update_hr_request(
  p_request_id uuid,
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
  item_id_row record;
  item_ids uuid[];
  current_item_ids uuid[];
  previous_status public.hr_request_status;
  line_no integer := 0;
  quantity bigint;
  issue_count integer := 0;
  increase_count integer := 0;
  combined_on_hand bigint;
  active_reserved bigint;
  issue_sum bigint;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('HR') then
    raise exception using errcode = '42501', message = 'HR role is required';
  end if;
  if p_request_id is null or p_distribution_date is null
     or btrim(coalesce(p_idempotency_key, '')) = ''
     or btrim(coalesce(p_request_fingerprint, '')) = ''
     or jsonb_typeof(p_issue_lines) <> 'array'
     or jsonb_typeof(p_increase_lines) <> 'array'
     or jsonb_array_length(p_issue_lines) > 1000
     or jsonb_array_length(p_increase_lines) > 1000
     or pg_column_size(p_issue_lines) + pg_column_size(p_increase_lines) > 10000000 then
    raise exception 'HR request update fields are invalid';
  end if;

  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('UPDATE_HR_REQUEST', p_idempotency_key, p_request_fingerprint, current_account)
  on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'UPDATE_HR_REQUEST' and idempotency_key = p_idempotency_key
    for update;
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' and command_row.result_entity_id is not null then
      select * into request_row from public.hr_requests where id = command_row.result_entity_id;
      return request_row;
    end if;
    raise exception using errcode = '40001', message = 'HR request update is already in progress or failed';
  end if;

  for line_value in select value from jsonb_array_elements(p_issue_lines) loop
    if jsonb_typeof(line_value) <> 'object'
       or btrim(coalesce(line_value ->> 'employeeId', '')) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or btrim(coalesce(line_value ->> 'itemId', '')) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or coalesce(line_value ->> 'quantity', '') !~ '^[1-9][0-9]{0,17}$' then
      raise exception 'Invalid HR issue line';
    end if;
  end loop;
  for line_value in select value from jsonb_array_elements(p_increase_lines) loop
    if jsonb_typeof(line_value) <> 'object'
       or btrim(coalesce(line_value ->> 'itemId', '')) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or coalesce(line_value ->> 'quantity', '') !~ '^[0-9][0-9]{0,17}$' then
      raise exception 'Invalid HR increase line';
    end if;
  end loop;

  select * into request_row from public.hr_requests where id = p_request_id;
  if request_row.id is null then raise exception 'HR request does not exist'; end if;
  if request_row.created_by <> current_account then
    raise exception using errcode = '42501', message = 'Only the request owner can update this request';
  end if;
  if request_row.status not in ('SUBMITTED', 'INVENTORY_REVIEW_REQUIRED') then
    raise exception 'Only pre-shipment HR requests can be updated';
  end if;
  previous_status := request_row.status;

  -- Global lock order: operation command -> item mutexes -> source request -> balances -> reservations.
  select coalesce(array_agg(item_id order by item_id), '{}'::uuid[])
    into item_ids from (
      select distinct item_id from public.hr_request_items where request_id = p_request_id
      union
      select distinct (value ->> 'itemId')::uuid from jsonb_array_elements(p_issue_lines)
      union
      select distinct (value ->> 'itemId')::uuid from jsonb_array_elements(p_increase_lines)
    ) requested_items;
  if cardinality(item_ids) = 0 then raise exception 'At least one request item is required'; end if;
  insert into public.inventory_item_locks (item_id)
  select item_id from unnest(item_ids) as requested(item_id) order by item_id on conflict (item_id) do nothing;
  for item_id_row in select item_id from unnest(item_ids) as requested(item_id) order by item_id loop
    perform 1 from public.inventory_item_locks where item_id = item_id_row.item_id for update;
  end loop;

  select * into request_row from public.hr_requests where id = p_request_id for update;
  if request_row.created_by <> current_account
     or request_row.status is distinct from previous_status then
    raise exception using errcode = '40001', message = 'HR request changed while update was locking; retry';
  end if;
  select coalesce(array_agg(item_id order by item_id), '{}'::uuid[])
    into current_item_ids from (
      select distinct item_id from public.hr_request_items where request_id = p_request_id
    ) current_items;
  if not (current_item_ids <@ item_ids) then
    raise exception using errcode = '40001', message = 'HR request items changed while update was locking; retry';
  end if;

  for item_id_row in select item_id from unnest(item_ids) as requested(item_id) order by item_id loop
    perform 1 from public.inventory_balances b
    join public.warehouses w on w.id = b.warehouse_id
    where b.item_id = item_id_row.item_id and w.is_active and w.purpose in ('HR', 'GENERAL')
    order by b.warehouse_id for update;
    perform 1 from public.inventory_reservations r
    where r.item_id = item_id_row.item_id and r.status = 'ACTIVE'
    order by r.source_hr_request_id, r.id for update;
  end loop;
  perform 1 from public.inventory_reservations
  where source_hr_request_id = p_request_id
  order by item_id, id for update;

  update public.inventory_reservations
     set status = 'RELEASED', closed_at = now()
   where source_hr_request_id = p_request_id and status = 'ACTIVE';
  update public.hr_requests
     set status = 'DRAFT', row_version = row_version + 1
   where id = p_request_id;

  delete from public.hr_issue_lines where request_id = p_request_id;
  delete from public.hr_request_items where request_id = p_request_id;

  for line_value in select value from jsonb_array_elements(p_issue_lines) loop
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
      from public.uniform_items where id = (line_value ->> 'itemId')::uuid and is_active;
    if item_row.id is null then raise exception 'Active uniform item does not exist'; end if;
    line_no := line_no + 1;
    insert into public.hr_issue_lines (
      request_id, employee_id, item_id, line_no, quantity,
      employee_no_snapshot, employee_name_snapshot, institution_id_snapshot,
      institution_code_snapshot, institution_name_snapshot, department_id_snapshot,
      department_code_snapshot, department_name_snapshot, item_code_snapshot,
      item_name_snapshot, unit_snapshot, size_snapshot
    ) values (
      p_request_id, employee_row.id, item_row.id, line_no, quantity,
      employee_row.employee_no, employee_row.name, employee_row.institution_id,
      employee_row.institution_code, employee_row.institution_name, employee_row.department_id,
      employee_row.department_code, employee_row.department_name, item_row.item_code,
      item_row.item_name, item_row.unit, item_row.size
    );
    insert into public.hr_request_items (request_id, item_id, issue_quantity, increase_quantity, item_code_snapshot, item_name_snapshot, unit_snapshot)
    values (p_request_id, item_row.id, quantity, 0, item_row.item_code, item_row.item_name, item_row.unit)
    on conflict (request_id, item_id) do update
      set issue_quantity = public.hr_request_items.issue_quantity + excluded.issue_quantity;
    issue_count := issue_count + 1;
  end loop;
  for line_value in select value from jsonb_array_elements(p_increase_lines) loop
    quantity := (line_value ->> 'quantity')::bigint;
    if quantity = 0 then continue; end if;
    select id, item_code, item_name, unit into item_row
      from public.uniform_items where id = (line_value ->> 'itemId')::uuid and is_active;
    if item_row.id is null then raise exception 'Active uniform item does not exist'; end if;
    insert into public.hr_request_items (request_id, item_id, issue_quantity, increase_quantity, item_code_snapshot, item_name_snapshot, unit_snapshot)
    values (p_request_id, item_row.id, 0, quantity, item_row.item_code, item_row.item_name, item_row.unit)
    on conflict (request_id, item_id) do update
      set increase_quantity = public.hr_request_items.increase_quantity + excluded.increase_quantity;
    increase_count := increase_count + 1;
  end loop;
  if issue_count = 0 and increase_count = 0 then raise exception 'HR request needs an issue or increase line'; end if;

  for item_row in select * from public.hr_request_items where request_id = p_request_id order by item_id for update loop
    select coalesce(sum(b.on_hand_quantity), 0) into combined_on_hand
    from public.inventory_balances b
    join public.warehouses w on w.id = b.warehouse_id
    where b.item_id = item_row.item_id and w.is_active and w.purpose in ('HR', 'GENERAL');
    select coalesce(sum(r.quantity), 0) into active_reserved
    from public.inventory_reservations r
    where r.item_id = item_row.item_id and r.status = 'ACTIVE';
    select coalesce(sum(l.quantity), 0) into issue_sum
    from public.hr_issue_lines l where l.request_id = p_request_id and l.item_id = item_row.item_id;
    if issue_sum <> item_row.issue_quantity then
      raise exception 'Issue summary does not match employee lines for item %', item_row.item_id;
    end if;
    if item_row.requested_transfer_quantity > combined_on_hand - active_reserved then
      raise exception 'Requested quantity exceeds available stock for item %', item_row.item_id;
    end if;
    insert into public.inventory_reservations (source_hr_request_id, item_id, quantity, status, closed_at)
    values (p_request_id, item_row.item_id, item_row.requested_transfer_quantity, 'ACTIVE', null)
    on conflict (source_hr_request_id, item_id) do update
      set quantity = excluded.quantity, status = 'ACTIVE', closed_at = null;
  end loop;

  update public.hr_requests
     set distribution_date = p_distribution_date,
         note = left(nullif(btrim(coalesce(p_note, '')), ''), 2000),
         status = 'SUBMITTED', submitted_at = now(), submitted_by = current_account,
         row_version = row_version + 1
   where id = p_request_id
   returning * into request_row;
  update public.operation_commands
     set status = 'SUCCEEDED', result_entity_type = 'hr_requests', result_entity_id = request_row.id, succeeded_at = now()
   where id = command_row.id;
  return request_row;
end;
$$;

revoke all on function public.update_hr_request(uuid, date, text, jsonb, jsonb, text, text) from public, anon;
grant execute on function public.update_hr_request(uuid, date, text, jsonb, jsonb, text, text) to authenticated;

create or replace function public.cancel_hr_request(
  p_request_id uuid,
  p_reason text,
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
  item_id_row record;
  item_ids uuid[];
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('HR') then
    raise exception using errcode = '42501', message = 'HR role is required';
  end if;
  if p_request_id is null or btrim(coalesce(p_reason, '')) = ''
     or btrim(coalesce(p_idempotency_key, '')) = ''
     or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'HR cancellation fields are invalid';
  end if;
  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('CANCEL_HR_REQUEST', p_idempotency_key, p_request_fingerprint, current_account)
  on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'CANCEL_HR_REQUEST' and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' then
      select * into request_row from public.hr_requests where id = command_row.result_entity_id;
      return request_row;
    end if;
    raise exception using errcode = '40001', message = 'HR cancellation is already in progress or failed';
  end if;

  select coalesce(array_agg(item_id order by item_id), '{}'::uuid[])
    into item_ids from (select distinct item_id from public.hr_request_items where request_id = p_request_id) requested_items;
  insert into public.inventory_item_locks (item_id)
  select item_id from unnest(item_ids) as requested(item_id) order by item_id on conflict (item_id) do nothing;
  for item_id_row in select item_id from unnest(item_ids) as requested(item_id) order by item_id loop
    perform 1 from public.inventory_item_locks where item_id = item_id_row.item_id for update;
  end loop;

  select * into request_row from public.hr_requests where id = p_request_id for update;
  if request_row.id is null then raise exception 'HR request does not exist'; end if;
  if request_row.status not in ('DRAFT', 'SUBMITTED', 'INVENTORY_REVIEW_REQUIRED') then
    raise exception 'Only pre-shipment HR requests can be cancelled';
  end if;
  update public.inventory_reservations
     set status = 'RELEASED', closed_at = now()
   where source_hr_request_id = p_request_id and status = 'ACTIVE';
  update public.hr_requests
     set status = 'CANCELLED', cancelled_at = now(), cancelled_by = current_account,
         cancellation_reason = left(btrim(p_reason), 2000), row_version = row_version + 1
   where id = p_request_id returning * into request_row;
  update public.operation_commands
     set status = 'SUCCEEDED', result_entity_type = 'hr_requests', result_entity_id = request_row.id, succeeded_at = now()
   where id = command_row.id;
  return request_row;
end;
$$;

create or replace function public.update_replenishment_request_draft(
  p_request_id uuid,
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
  item_id_row record;
  item_ids uuid[];
  quantity bigint;
  line_count integer := 0;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('HR') then
    raise exception using errcode = '42501', message = 'HR role is required';
  end if;
  if p_request_id is null or p_lines is null or jsonb_typeof(p_lines) <> 'array'
     or jsonb_array_length(p_lines) = 0 or jsonb_array_length(p_lines) > 1000
     or pg_column_size(p_lines) > 10000000
     or btrim(coalesce(p_idempotency_key, '')) = ''
     or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'Replenishment draft update fields are invalid';
  end if;
  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('UPDATE_REPLENISHMENT_REQUEST_DRAFT', p_idempotency_key, p_request_fingerprint, current_account)
  on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'UPDATE_REPLENISHMENT_REQUEST_DRAFT' and idempotency_key = p_idempotency_key
    for update;
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' then
      select * into request_row from public.replenishment_requests where id = command_row.result_entity_id;
      return request_row;
    end if;
    raise exception using errcode = '40001', message = 'Replenishment draft update is already in progress or failed';
  end if;

  -- Validate UUID-shaped identifiers before deriving the mutex set.
  for line_value in select value from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(line_value) <> 'object'
       or btrim(coalesce(line_value ->> 'itemId', '')) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or coalesce(line_value ->> 'quantity', '') !~ '^[1-9][0-9]{0,17}$' then
      raise exception 'Invalid replenishment line';
    end if;
  end loop;
  select * into request_row from public.replenishment_requests where id = p_request_id;
  if request_row.id is null then raise exception 'Replenishment request does not exist'; end if;
  if request_row.created_by <> current_account then
    raise exception using errcode = '42501', message = 'Only the request owner can update this draft';
  end if;
  if request_row.status <> 'DRAFT' then raise exception 'Only DRAFT replenishment requests can be updated'; end if;
  select coalesce(array_agg(item_id order by item_id), '{}'::uuid[])
    into item_ids from (
      select distinct item_id from public.replenishment_request_lines where request_id = p_request_id
      union
      select distinct (value ->> 'itemId')::uuid from jsonb_array_elements(p_lines)
    ) requested_items;
  insert into public.inventory_item_locks (item_id)
  select item_id from unnest(item_ids) as requested(item_id) order by item_id on conflict (item_id) do nothing;
  for item_id_row in select item_id from unnest(item_ids) as requested(item_id) order by item_id loop
    perform 1 from public.inventory_item_locks where item_id = item_id_row.item_id for update;
  end loop;

  select * into request_row from public.replenishment_requests where id = p_request_id for update;
  if request_row.id is null then raise exception 'Replenishment request does not exist'; end if;
  if request_row.created_by <> current_account then
    raise exception using errcode = '42501', message = 'Only the request owner can update this draft';
  end if;
  if request_row.status <> 'DRAFT' then raise exception 'Only DRAFT replenishment requests can be updated'; end if;

  delete from public.replenishment_request_lines where request_id = p_request_id;
  for line_value in select value from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(line_value) <> 'object'
       or btrim(coalesce(line_value ->> 'itemId', '')) = ''
       or coalesce(line_value ->> 'quantity', '') !~ '^[1-9][0-9]{0,17}$' then
      raise exception 'Invalid replenishment line';
    end if;
    quantity := (line_value ->> 'quantity')::bigint;
    select id, item_code, item_name, unit into item_row
      from public.uniform_items where id = (line_value ->> 'itemId')::uuid and is_active;
    if item_row.id is null then raise exception 'Active uniform item does not exist'; end if;
    insert into public.replenishment_request_lines (
      request_id, item_id, requested_quantity, item_code_snapshot, item_name_snapshot, unit_snapshot
    ) values (
      p_request_id, item_row.id, quantity, item_row.item_code, item_row.item_name, item_row.unit
    );
    line_count := line_count + 1;
  end loop;
  if line_count = 0 then raise exception 'Replenishment request needs at least one item'; end if;

  update public.replenishment_requests
     set note = left(nullif(btrim(coalesce(p_note, '')), ''), 2000), row_version = row_version + 1
   where id = p_request_id returning * into request_row;
  update public.operation_commands
     set status = 'SUCCEEDED', result_entity_type = 'replenishment_requests', result_entity_id = request_row.id, succeeded_at = now()
   where id = command_row.id;
  return request_row;
end;
$$;

create or replace function public.cancel_replenishment_request(
  p_request_id uuid,
  p_reason text,
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
  item_id_row record;
  item_ids uuid[];
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('HR') then
    raise exception using errcode = '42501', message = 'HR role is required';
  end if;
  if p_request_id is null or btrim(coalesce(p_reason, '')) = ''
     or btrim(coalesce(p_idempotency_key, '')) = ''
     or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'Replenishment cancellation fields are invalid';
  end if;
  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('CANCEL_REPLENISHMENT_REQUEST', p_idempotency_key, p_request_fingerprint, current_account)
  on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'CANCEL_REPLENISHMENT_REQUEST' and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' then
      select * into request_row from public.replenishment_requests where id = command_row.result_entity_id;
      return request_row;
    end if;
    raise exception using errcode = '40001', message = 'Replenishment cancellation is already in progress or failed';
  end if;

  select coalesce(array_agg(item_id order by item_id), '{}'::uuid[])
    into item_ids from (select distinct item_id from public.replenishment_request_lines where request_id = p_request_id) requested_items;
  insert into public.inventory_item_locks (item_id)
  select item_id from unnest(item_ids) as requested(item_id) order by item_id on conflict (item_id) do nothing;
  for item_id_row in select item_id from unnest(item_ids) as requested(item_id) order by item_id loop
    perform 1 from public.inventory_item_locks where item_id = item_id_row.item_id for update;
  end loop;

  select * into request_row from public.replenishment_requests where id = p_request_id for update;
  if request_row.id is null then raise exception 'Replenishment request does not exist'; end if;
  if request_row.status not in ('DRAFT', 'SUBMITTED') then
    raise exception 'Only pre-shipment replenishment requests can be cancelled';
  end if;
  update public.replenishment_requests
     set status = 'CANCELLED', cancelled_at = now(), cancelled_by = current_account,
         cancellation_reason = left(btrim(p_reason), 2000), row_version = row_version + 1
   where id = p_request_id returning * into request_row;
  update public.operation_commands
     set status = 'SUCCEEDED', result_entity_type = 'replenishment_requests', result_entity_id = request_row.id, succeeded_at = now()
   where id = command_row.id;
  return request_row;
end;
$$;

revoke all on function public.update_hr_request_draft(uuid, date, text, jsonb, jsonb, text, text) from public, anon;
revoke all on function public.cancel_hr_request(uuid, text, text, text) from public, anon;
revoke all on function public.update_replenishment_request_draft(uuid, text, jsonb, text, text) from public, anon;
revoke all on function public.cancel_replenishment_request(uuid, text, text, text) from public, anon;
grant execute on function public.update_hr_request_draft(uuid, date, text, jsonb, jsonb, text, text) to authenticated;
grant execute on function public.cancel_hr_request(uuid, text, text, text) to authenticated;
grant execute on function public.update_replenishment_request_draft(uuid, text, jsonb, text, text) to authenticated;
grant execute on function public.cancel_replenishment_request(uuid, text, text, text) to authenticated;
