-- Demand entry is RPC-only: frozen campaign scope, row lock, and no direct PostgREST DML.

alter table public.seasonal_campaign_items
  add column if not exists size_snapshot text;
alter table public.seasonal_campaign_employees
  add column if not exists institution_code_snapshot text,
  add column if not exists department_code_snapshot text;

create or replace function private.freeze_seasonal_scope_snapshots()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  if new.status = 'OPEN' and old.status is distinct from 'OPEN' then
    if exists (
      select 1 from public.seasonal_campaign_employees ce
      join public.employees e on e.id = ce.employee_id
      where ce.campaign_id = new.id and e.employment_status <> 'ACTIVE'
    ) then
      raise exception 'An OPEN seasonal campaign cannot include inactive employees';
    end if;
    update public.seasonal_campaign_employees ce
    set employee_no_snapshot = e.employee_no,
        employee_name_snapshot = e.name,
        institution_id_snapshot = e.institution_id,
        department_id_snapshot = e.department_id,
        institution_code_snapshot = i.code,
        department_code_snapshot = d.code
    from public.employees e
    join public.institutions i on i.id = e.institution_id
    join public.departments d on d.id = e.department_id and d.institution_id = e.institution_id
    where ce.campaign_id = new.id and ce.employee_id = e.id;
    update public.seasonal_campaign_items ci
    set size_snapshot = i.size
    from public.uniform_items i
    where ci.campaign_id = new.id and ci.item_id = i.id;
  end if;
  return new;
end;
$$;

create or replace function private.record_seasonal_hr_demand_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  if new.campaign_id <> old.campaign_id or new.employee_id <> old.employee_id or new.item_id <> old.item_id then
    raise exception 'Campaign, employee, and item cannot be changed on a demand line';
  end if;
  if private.has_role('HR') then
    new.hr_modified := true;
    new.updated_by := private.current_account_id();
    new.updated_at := now();
    insert into public.seasonal_demand_line_changes (
      demand_line_id, old_quantity, new_quantity, old_note, new_note, changed_by
    ) values (
      old.id, old.quantity, new.quantity, old.hr_note, new.hr_note, private.current_account_id()
    );
    return new;
  end if;
  if private.has_role('DEMAND_COORDINATOR') then
    new.updated_by := private.current_account_id();
    new.updated_at := now();
    return new;
  end if;
  raise exception using errcode = '42501', message = 'Demand coordinator or HR role is required';
end;
$$;

create or replace function public.upsert_seasonal_demand_line(
  p_campaign_id uuid,
  p_employee_id uuid,
  p_item_id uuid,
  p_quantity bigint,
  p_note text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.seasonal_demand_lines
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  campaign_row public.seasonal_campaigns;
  result_row public.seasonal_demand_lines;
  employee_row record;
  item_row record;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('DEMAND_COORDINATOR') then
    raise exception using errcode = '42501', message = 'Demand coordinator role is required';
  end if;
  if p_campaign_id is null or p_employee_id is null or p_item_id is null or p_quantity is null or p_quantity < 0
     or btrim(coalesce(p_idempotency_key, '')) = '' or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'Seasonal demand fields are invalid';
  end if;
  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('UPSERT_SEASONAL_DEMAND_LINE', p_idempotency_key, p_request_fingerprint, current_account)
  on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'UPSERT_SEASONAL_DEMAND_LINE' and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' then
      select * into result_row from public.seasonal_demand_lines where id = command_row.result_entity_id;
      return result_row;
    end if;
    raise exception using errcode = '40001', message = 'demand operation is already in progress or failed';
  end if;

  select * into campaign_row from public.seasonal_campaigns where id = p_campaign_id for update;
  if campaign_row.id is null or campaign_row.status <> 'OPEN' or current_timestamp < campaign_row.opens_at or current_timestamp >= campaign_row.closes_at then
    raise exception 'Campaign is not open for demand entry';
  end if;
  select ce.employee_id, ce.employee_no_snapshot, ce.employee_name_snapshot,
         ce.institution_id_snapshot, ce.department_id_snapshot
    into employee_row
    from public.seasonal_campaign_employees ce
   where ce.campaign_id = p_campaign_id and ce.employee_id = p_employee_id
     and exists (select 1 from public.coordinator_scopes cs where cs.account_id = current_account
                 and cs.institution_id = ce.institution_id_snapshot and cs.department_id = ce.department_id_snapshot);
  if employee_row.employee_id is null then raise exception 'Employee is outside frozen campaign scope'; end if;
  select ci.item_id, ci.item_code_snapshot, ci.item_name_snapshot, ci.size_snapshot, ci.unit_snapshot
    into item_row
    from public.seasonal_campaign_items ci
   where ci.campaign_id = p_campaign_id and ci.item_id = p_item_id;
  if item_row.item_id is null then raise exception 'Uniform item is outside campaign scope'; end if;

  insert into public.seasonal_demand_lines (
    campaign_id, employee_id, item_id, quantity, entered_by, updated_by, hr_modified, hr_note,
    employee_no_snapshot, employee_name_snapshot, institution_code_snapshot, department_code_snapshot,
    item_code_snapshot, item_name_snapshot, size_snapshot, unit_snapshot
  ) values (
    p_campaign_id, p_employee_id, p_item_id, p_quantity, current_account, current_account, false,
    left(nullif(btrim(coalesce(p_note, '')), ''), 2000), employee_row.employee_no_snapshot,
    employee_row.employee_name_snapshot,
    employee_row.institution_code_snapshot,
    employee_row.department_code_snapshot,
    item_row.item_code_snapshot, item_row.item_name_snapshot, item_row.size_snapshot, item_row.unit_snapshot
  ) on conflict (campaign_id, employee_id, item_id) do update
    set quantity = excluded.quantity, hr_note = excluded.hr_note, hr_modified = false,
        updated_by = current_account, updated_at = now()
  returning * into result_row;
  update public.operation_commands set status = 'SUCCEEDED', result_entity_type = 'seasonal_demand_lines',
    result_entity_id = result_row.id, succeeded_at = now() where id = command_row.id;
  return result_row;
end;
$$;

drop policy if exists seasonal_demand_lines_draft_write on public.seasonal_demand_lines;
drop policy if exists seasonal_demand_lines_window_update on public.seasonal_demand_lines;
drop policy if exists seasonal_demand_lines_hr_update on public.seasonal_demand_lines;
revoke insert, update on table public.seasonal_demand_lines from authenticated;
revoke all on function private.record_seasonal_hr_demand_change() from public, anon, authenticated;
revoke all on function public.upsert_seasonal_demand_line(uuid, uuid, uuid, bigint, text, text, text) from public, anon;
grant execute on function public.upsert_seasonal_demand_line(uuid, uuid, uuid, bigint, text, text, text) to authenticated;
