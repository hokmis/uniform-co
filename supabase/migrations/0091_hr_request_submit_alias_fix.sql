-- Fix PostgreSQL UPDATE ... FROM scoping in submit_hr_request.
-- The UPDATE target alias `l` is visible in WHERE, but not in a FROM JOIN ON clause.

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
  if btrim(coalesce(p_idempotency_key, '')) = '' or btrim(coalesce(p_request_fingerprint, '')) = '' then
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
    from public.hr_issue_lines l
    join public.employees e on e.id = l.employee_id
    join public.uniform_items ui on ui.id = l.item_id
    where l.request_id = p_request_id
      and (e.employment_status <> 'ACTIVE' or not ui.is_active)
  ) then
    raise exception 'Only active employees and uniform items may be submitted';
  end if;

  if exists (
    select 1
    from public.hr_issue_lines l
    left join public.hr_request_items r
      on r.request_id = l.request_id and r.item_id = l.item_id
    where l.request_id = p_request_id and r.id is null
  ) then
    raise exception 'Every employee issue line must have a matching request item summary';
  end if;

  update public.hr_issue_lines l
  set employee_no_snapshot = e.employee_no,
      employee_name_snapshot = e.name,
      institution_id_snapshot = e.institution_id,
      institution_code_snapshot = i.code,
      institution_name_snapshot = i.name,
      department_id_snapshot = e.department_id,
      department_code_snapshot = d.code,
      department_name_snapshot = d.name,
      item_code_snapshot = ui.item_code,
      item_name_snapshot = ui.item_name,
      size_snapshot = ui.size,
      unit_snapshot = ui.unit
  from public.employees e
  join public.institutions i on i.id = e.institution_id
  join public.departments d on d.id = e.department_id and d.institution_id = e.institution_id
  cross join public.uniform_items ui
  where l.request_id = p_request_id
    and l.employee_id = e.id
    and l.item_id = ui.id;

  update public.hr_request_items r
  set item_code_snapshot = ui.item_code,
      item_name_snapshot = ui.item_name,
      unit_snapshot = ui.unit
  from public.uniform_items ui
  where r.request_id = p_request_id and r.item_id = ui.id;

  for item_row in
    select * from public.hr_request_items where request_id = p_request_id order by item_id for update
  loop
    perform 1
    from public.inventory_balances b
    join public.warehouses w on w.id = b.warehouse_id
    where b.item_id = item_row.item_id
      and w.is_active
      and w.purpose in ('HR', 'GENERAL')
    order by b.warehouse_id
    for update;

    select coalesce(sum(b.on_hand_quantity), 0)
      into combined_on_hand
    from public.inventory_balances b
    join public.warehouses w on w.id = b.warehouse_id
    where b.item_id = item_row.item_id
      and w.is_active
      and w.purpose in ('HR', 'GENERAL');

    perform 1 from public.inventory_reservations r
    where r.item_id = item_row.item_id and r.status = 'ACTIVE'
    order by r.source_hr_request_id, r.id
    for update;

    select coalesce(sum(r.quantity), 0)
      into active_reserved
    from public.inventory_reservations r
    where r.item_id = item_row.item_id and r.status = 'ACTIVE';

    select coalesce(sum(l.quantity), 0)
      into issue_sum
    from public.hr_issue_lines l
    where l.request_id = p_request_id and l.item_id = item_row.item_id;

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
