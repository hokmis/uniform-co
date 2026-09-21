-- Harden the HR submit path against PostgreSQL UPDATE ... FROM scope errors.
--
-- 0091 moved the uniform-item join out of the target UPDATE join condition,
-- but the target alias was still named `l` and the same short alias remained
-- in the submit validation queries.  Keep source rows in a separate derived
-- table and use descriptive aliases throughout this path.

create or replace function private.validate_hr_request_submission()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  if old.status = 'DRAFT' and new.status <> 'DRAFT' then
    if exists (
      select 1
      from public.hr_issue_lines source_line
      where source_line.request_id = new.id
        and (
          source_line.employee_no_snapshot is null
          or source_line.employee_name_snapshot is null
          or source_line.institution_id_snapshot is null
          or source_line.institution_code_snapshot is null
          or source_line.institution_name_snapshot is null
          or source_line.department_id_snapshot is null
          or source_line.department_code_snapshot is null
          or source_line.department_name_snapshot is null
          or source_line.item_code_snapshot is null
          or source_line.item_name_snapshot is null
          or source_line.unit_snapshot is null
        )
    ) then
      raise exception 'Submitted HR requests require complete issue-line snapshots';
    end if;
    if exists (
      select 1
      from public.hr_request_items request_item
      where request_item.request_id = new.id
        and (
          request_item.item_code_snapshot is null
          or request_item.item_name_snapshot is null
          or request_item.unit_snapshot is null
        )
    ) then
      raise exception 'Submitted HR requests require complete item snapshots';
    end if;
    if exists (
      select 1
      from public.hr_issue_lines source_line
      left join public.hr_request_items request_item
        on request_item.request_id = source_line.request_id
       and request_item.item_id = source_line.item_id
      where source_line.request_id = new.id
        and request_item.id is null
    ) then
      raise exception 'Every employee issue line must have a matching request item summary';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.submit_hr_request(
  p_request_id uuid,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.hr_requests
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  request_row public.hr_requests;
  command_row public.operation_commands;
  item_row record;
  item_id_row record;
  current_account uuid;
  locked_item_ids uuid[];
  current_item_ids uuid[];
  combined_on_hand bigint;
  active_reserved bigint;
  issue_sum bigint;
begin
  current_account := private.current_account_id();
  if auth.uid() is null
     or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null
     or not private.has_role('HR') then
    raise exception using errcode = '42501', message = 'HR role is required';
  end if;
  if btrim(coalesce(p_idempotency_key, '')) = ''
     or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'idempotency_key and request_fingerprint are required';
  end if;

  insert into public.operation_commands (
    operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id
  ) values (
    'SUBMIT_HR_REQUEST', p_idempotency_key, p_request_fingerprint, current_account
  ) on conflict (operation_code, idempotency_key) do nothing
  returning * into command_row;

  if command_row.id is null then
    select * into command_row
    from public.operation_commands
    where operation_code = 'SUBMIT_HR_REQUEST'
      and idempotency_key = p_idempotency_key
    for update;
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' and command_row.result_entity_id = p_request_id then
      select * into request_row from public.hr_requests where id = p_request_id;
      return request_row;
    end if;
    raise exception using errcode = '40001', message = 'request is already in progress or failed';
  end if;

  -- Global lock order: operation command -> item mutexes -> source request -> balances -> reservations.
  select coalesce(array_agg(item_id order by item_id), '{}'::uuid[])
    into locked_item_ids
  from (
    select distinct item_id
    from public.hr_request_items
    where request_id = p_request_id
  ) requested_items;
  if cardinality(locked_item_ids) = 0 then
    raise exception 'At least one request item is required';
  end if;

  insert into public.inventory_item_locks (item_id)
  select item_id
  from unnest(locked_item_ids) as requested(item_id)
  order by item_id
  on conflict (item_id) do nothing;

  for item_id_row in
    select item_id from unnest(locked_item_ids) as requested(item_id) order by item_id
  loop
    perform 1 from public.inventory_item_locks where item_id = item_id_row.item_id for update;
  end loop;

  select * into request_row
  from public.hr_requests
  where id = p_request_id
  for update;

  if request_row.id is null then
    raise exception 'HR request does not exist';
  end if;
  if request_row.created_by <> current_account then
    raise exception using errcode = '42501', message = 'Only the request owner can submit this draft';
  end if;
  if request_row.status <> 'DRAFT' then
    raise exception 'Only DRAFT requests can be submitted';
  end if;

  select coalesce(array_agg(item_id order by item_id), '{}'::uuid[])
    into current_item_ids
  from (
    select distinct item_id
    from public.hr_request_items
    where request_id = p_request_id
  ) current_items;
  if current_item_ids is distinct from locked_item_ids then
    raise exception using errcode = '40001', message = 'Request items changed while submission was locking; retry';
  end if;

  if exists (
    select 1
    from public.hr_issue_lines source_line
    join public.employees employee_row on employee_row.id = source_line.employee_id
    join public.uniform_items uniform_item on uniform_item.id = source_line.item_id
    where source_line.request_id = p_request_id
      and (employee_row.employment_status <> 'ACTIVE' or not uniform_item.is_active)
  ) then
    raise exception 'Only active employees and uniform items may be submitted';
  end if;

  if exists (
    select 1
    from public.hr_issue_lines source_line
    left join public.hr_request_items request_item
      on request_item.request_id = source_line.request_id
     and request_item.item_id = source_line.item_id
    where source_line.request_id = p_request_id
      and request_item.id is null
  ) then
    raise exception 'Every employee issue line must have a matching request item summary';
  end if;

  -- Do not reference the UPDATE target from a FROM JOIN condition.  The
  -- source subquery is fully independent, and the outer update joins by PK.
  update public.hr_issue_lines as target_line
  set employee_no_snapshot = source_line.employee_no,
      employee_name_snapshot = source_line.name,
      institution_id_snapshot = source_line.institution_id,
      institution_code_snapshot = source_line.institution_code,
      institution_name_snapshot = source_line.institution_name,
      department_id_snapshot = source_line.department_id,
      department_code_snapshot = source_line.department_code,
      department_name_snapshot = source_line.department_name,
      item_code_snapshot = source_line.item_code,
      item_name_snapshot = source_line.item_name,
      size_snapshot = source_line.size,
      unit_snapshot = source_line.unit
  from (
    select issue_line.id,
           employee_row.employee_no,
           employee_row.name,
           employee_row.institution_id,
           institution_row.code as institution_code,
           institution_row.name as institution_name,
           employee_row.department_id,
           department_row.code as department_code,
           department_row.name as department_name,
           uniform_item.item_code,
           uniform_item.item_name,
           uniform_item.size,
           uniform_item.unit
    from public.hr_issue_lines issue_line
    join public.employees employee_row on employee_row.id = issue_line.employee_id
    join public.institutions institution_row on institution_row.id = employee_row.institution_id
    join public.departments department_row
      on department_row.id = employee_row.department_id
     and department_row.institution_id = employee_row.institution_id
    join public.uniform_items uniform_item on uniform_item.id = issue_line.item_id
    where issue_line.request_id = p_request_id
  ) source_line
  where target_line.id = source_line.id
    and target_line.request_id = p_request_id;

  update public.hr_request_items as target_item
  set item_code_snapshot = uniform_item.item_code,
      item_name_snapshot = uniform_item.item_name,
      unit_snapshot = uniform_item.unit
  from public.uniform_items uniform_item
  where target_item.request_id = p_request_id
    and target_item.item_id = uniform_item.id;

  for item_row in
    select * from public.hr_request_items where request_id = p_request_id order by item_id for update
  loop
    perform 1
    from public.inventory_balances balance_row
    join public.warehouses warehouse_row on warehouse_row.id = balance_row.warehouse_id
    where balance_row.item_id = item_row.item_id
      and warehouse_row.is_active
      and warehouse_row.purpose in ('HR', 'GENERAL')
    order by balance_row.warehouse_id
    for update;

    select coalesce(sum(balance_row.on_hand_quantity), 0)
      into combined_on_hand
    from public.inventory_balances balance_row
    join public.warehouses warehouse_row on warehouse_row.id = balance_row.warehouse_id
    where balance_row.item_id = item_row.item_id
      and warehouse_row.is_active
      and warehouse_row.purpose in ('HR', 'GENERAL');

    perform 1 from public.inventory_reservations reservation_row
    where reservation_row.item_id = item_row.item_id
      and reservation_row.status = 'ACTIVE'
    order by reservation_row.source_hr_request_id, reservation_row.id
    for update;

    select coalesce(sum(reservation_row.quantity), 0)
      into active_reserved
    from public.inventory_reservations reservation_row
    where reservation_row.item_id = item_row.item_id
      and reservation_row.status = 'ACTIVE';

    select coalesce(sum(issue_line.quantity), 0)
      into issue_sum
    from public.hr_issue_lines issue_line
    where issue_line.request_id = p_request_id
      and issue_line.item_id = item_row.item_id;

    if issue_sum <> item_row.issue_quantity then
      raise exception 'Issue summary does not match employee lines for item %', item_row.item_id;
    end if;
    if item_row.requested_transfer_quantity > combined_on_hand - active_reserved then
      raise exception 'Requested quantity exceeds available stock for item %', item_row.item_id;
    end if;

    insert into public.inventory_reservations (source_hr_request_id, item_id, quantity)
    values (p_request_id, item_row.item_id, item_row.requested_transfer_quantity);
  end loop;

  update public.hr_requests
  set status = 'SUBMITTED',
      submitted_at = now(),
      submitted_by = current_account,
      row_version = row_version + 1
  where id = p_request_id
  returning * into request_row;

  update public.operation_commands
  set status = 'SUCCEEDED',
      result_entity_type = 'hr_requests',
      result_entity_id = p_request_id,
      succeeded_at = now()
  where id = command_row.id;

  return request_row;
end;
$$;

revoke all on function public.submit_hr_request(uuid, text, text) from public, anon;
grant execute on function public.submit_hr_request(uuid, text, text) to authenticated;
