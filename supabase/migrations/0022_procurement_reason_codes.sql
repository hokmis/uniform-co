-- Procurement decisions use maintained reason codes and never target inactive suppliers.
create table public.procurement_difference_reasons (
  code text primary key check (btrim(code) <> '' and code = upper(btrim(code))),
  name text not null check (btrim(name) <> ''),
  is_active boolean not null default true
);

insert into public.procurement_difference_reasons (code, name) values
  ('MOQ', '符合最低採購量'),
  ('PACK_SIZE', '符合包裝倍數'),
  ('SUPPLIER_LIMIT', '廠商供貨限制'),
  ('CANCELLED', '取消採購'),
  ('OTHER', '其他')
on conflict (code) do nothing;

alter table public.seasonal_procurement_lines
  add column if not exists difference_reason_code text
    references public.procurement_difference_reasons(code);

alter table public.procurement_difference_reasons enable row level security;
revoke all on table public.procurement_difference_reasons from public, anon, authenticated;
grant select on table public.procurement_difference_reasons to authenticated;
create policy procurement_difference_reasons_read on public.procurement_difference_reasons
  for select to authenticated using (
    private.has_role('SYSTEM_ADMIN') or (is_active and (private.has_role('PROCUREMENT') or private.has_role('HR') or private.has_role('CEO')))
  );

create or replace function public.maintain_procurement_difference_reason(
  p_code text,
  p_name text,
  p_is_active boolean,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.procurement_difference_reasons
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  reason_row public.procurement_difference_reasons;
  reason_code text;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('SYSTEM_ADMIN') then
    raise exception using errcode = '42501', message = 'SYSTEM_ADMIN role is required';
  end if;
  reason_code := upper(btrim(coalesce(p_code, '')));
  if reason_code = '' or btrim(coalesce(p_name, '')) = ''
     or btrim(coalesce(p_idempotency_key, '')) = '' or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'reason code, name, idempotency key and fingerprint are required';
  end if;
  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('MAINTAIN_PROCUREMENT_REASON', p_idempotency_key, p_request_fingerprint, current_account)
  on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'MAINTAIN_PROCUREMENT_REASON' and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' then
      select * into reason_row from public.procurement_difference_reasons where code = reason_code;
      return reason_row;
    end if;
    raise exception using errcode = '40001', message = 'reason maintenance is already in progress or failed';
  end if;
  insert into public.procurement_difference_reasons (code, name, is_active)
  values (reason_code, left(btrim(p_name), 120), coalesce(p_is_active, true))
  on conflict (code) do update set name = excluded.name, is_active = excluded.is_active
  returning * into reason_row;
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'procurement_difference_reasons', succeeded_at = now()
  where id = command_row.id;
  return reason_row;
end;
$$;

revoke all on function public.maintain_procurement_difference_reason(text, text, boolean, text, text) from public, anon;
grant execute on function public.maintain_procurement_difference_reason(text, text, boolean, text, text) to authenticated;

create or replace function public.set_seasonal_procurement_line(
  p_approval_line_id uuid,
  p_supplier_id uuid,
  p_final_purchase_quantity bigint,
  p_difference_reason text,
  p_note text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.seasonal_procurement_lines
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  approval_line_row public.seasonal_approval_lines;
  approval_row public.seasonal_approvals;
  supplier_row public.suppliers;
  supplier_item_row public.supplier_uniform_items;
  procurement_row public.seasonal_procurement_lines;
  reason_code text;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('PROCUREMENT') then
    raise exception using errcode = '42501', message = 'PROCUREMENT role is required';
  end if;
  if p_final_purchase_quantity < 0 then raise exception 'final purchase quantity cannot be negative'; end if;
  if btrim(coalesce(p_idempotency_key, '')) = '' or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'idempotency_key and request_fingerprint are required';
  end if;
  insert into public.operation_commands (
    operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id
  ) values (
    'SET_SEASONAL_PROCUREMENT_LINE', p_idempotency_key, p_request_fingerprint, current_account
  ) on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'SET_SEASONAL_PROCUREMENT_LINE' and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' then
      select * into procurement_row from public.seasonal_procurement_lines where id = command_row.result_entity_id;
      return procurement_row;
    end if;
    raise exception using errcode = '40001', message = 'procurement decision is already in progress or failed';
  end if;
  select * into approval_line_row from public.seasonal_approval_lines where id = p_approval_line_id for update;
  if approval_line_row.id is null then raise exception 'Approval line not found'; end if;
  select a.* into approval_row from public.seasonal_approvals a where a.id = approval_line_row.approval_id for update;
  if approval_row.id is null or approval_row.status <> 'APPROVED' then raise exception 'Approval is not final'; end if;
  select * into supplier_row from public.suppliers where id = p_supplier_id and is_active for update;
  if supplier_row.id is null then raise exception 'Supplier is not active'; end if;
  select * into supplier_item_row from public.supplier_uniform_items si
  where si.supplier_id = p_supplier_id and si.item_id = approval_line_row.item_id and si.is_active for update;
  if supplier_item_row.supplier_id is null then raise exception 'Supplier does not supply this item'; end if;
  select * into procurement_row from public.seasonal_procurement_lines
  where approval_line_id = approval_line_row.id for update;
  if procurement_row.id is not null then
    raise exception 'The procurement decision is immutable; append a justified limit change instead';
  end if;
  reason_code := nullif(upper(btrim(p_difference_reason)), '');
  if p_final_purchase_quantity <> approval_line_row.approved_quantity then
    if reason_code is null or not exists (
      select 1 from public.procurement_difference_reasons r
      where r.code = reason_code and r.is_active
    ) then
      raise exception 'An active procurement difference reason code is required';
    end if;
  else
    reason_code := null;
  end if;
  if supplier_item_row.minimum_order_quantity is not null
     and p_final_purchase_quantity > 0 and p_final_purchase_quantity < supplier_item_row.minimum_order_quantity then
    raise exception 'Final purchase quantity is below the supplier MOQ';
  end if;
  insert into public.seasonal_procurement_lines (
    approval_line_id, item_id, supplier_id, approved_quantity_snapshot,
    minimum_order_quantity_snapshot, final_purchase_quantity, difference_reason,
    difference_reason_code, note, decided_by
  ) values (
    approval_line_row.id, approval_line_row.item_id, p_supplier_id, approval_line_row.approved_quantity,
    supplier_item_row.minimum_order_quantity, p_final_purchase_quantity, reason_code,
    reason_code, nullif(btrim(p_note), ''), current_account
  )
  returning * into procurement_row;
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'seasonal_procurement_lines',
      result_entity_id = procurement_row.id, succeeded_at = now()
  where id = command_row.id;
  return procurement_row;
end;
$$;
