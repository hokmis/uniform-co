-- HR corrections remain available only through an auditable RPC after coordinator DML is removed.

create or replace function public.correct_seasonal_demand_line(
  p_demand_line_id uuid,
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
  line_row public.seasonal_demand_lines;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('HR') then
    raise exception using errcode = '42501', message = 'HR role is required';
  end if;
  if p_demand_line_id is null or p_quantity is null or p_quantity < 0
     or btrim(coalesce(p_idempotency_key, '')) = '' or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'HR correction fields are invalid';
  end if;
  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('CORRECT_SEASONAL_DEMAND_LINE', p_idempotency_key, p_request_fingerprint, current_account)
  on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands where operation_code = 'CORRECT_SEASONAL_DEMAND_LINE'
      and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' then
      select * into line_row from public.seasonal_demand_lines where id = command_row.result_entity_id;
      return line_row;
    end if;
    raise exception using errcode = '40001', message = 'HR correction is already in progress or failed';
  end if;
  select c.* into campaign_row
    from public.seasonal_campaigns c
    join public.seasonal_demand_lines l on l.campaign_id = c.id
   where l.id = p_demand_line_id
   for update of c;
  if campaign_row.id is null or campaign_row.status <> 'HR_REVIEW' then
    raise exception 'Only HR_REVIEW campaign demand can be corrected';
  end if;
  select * into line_row from public.seasonal_demand_lines l where l.id = p_demand_line_id for update;
  if line_row.id is null then raise exception 'Demand line does not exist'; end if;
  update public.seasonal_demand_lines
  set quantity = p_quantity, hr_note = left(nullif(btrim(coalesce(p_note, '')), ''), 2000)
  where id = p_demand_line_id returning * into line_row;
  update public.operation_commands set status = 'SUCCEEDED', result_entity_type = 'seasonal_demand_lines',
    result_entity_id = line_row.id, succeeded_at = now() where id = command_row.id;
  return line_row;
end;
$$;

revoke all on function public.correct_seasonal_demand_line(uuid, bigint, text, text, text) from public, anon;
grant execute on function public.correct_seasonal_demand_line(uuid, bigint, text, text, text) to authenticated;

drop policy if exists seasonal_campaign_scope_read on public.seasonal_campaign_employees;
create policy seasonal_campaign_scope_read on public.seasonal_campaign_employees
  for select to authenticated using (
    private.has_role('HR') or private.has_role('CEO') or private.has_role('PROCUREMENT')
    or (private.has_role('DEMAND_COORDINATOR') and exists (
      select 1 from public.coordinator_scopes cs
      where cs.account_id = private.current_account_id()
        and cs.institution_id = seasonal_campaign_employees.institution_id_snapshot
        and cs.department_id = seasonal_campaign_employees.department_id_snapshot
    ))
  );

drop policy if exists seasonal_demand_lines_read on public.seasonal_demand_lines;
create policy seasonal_demand_lines_read on public.seasonal_demand_lines
  for select to authenticated using (
    private.has_role('HR') or private.has_role('CEO') or private.has_role('PROCUREMENT')
    or (private.has_role('DEMAND_COORDINATOR') and exists (
      select 1 from public.seasonal_campaign_employees ce
      join public.coordinator_scopes cs on cs.institution_id = ce.institution_id_snapshot
        and cs.department_id = ce.department_id_snapshot
        and cs.account_id = private.current_account_id()
      where ce.campaign_id = seasonal_demand_lines.campaign_id and ce.employee_id = seasonal_demand_lines.employee_id
    ))
  );
