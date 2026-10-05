-- Targeted schema-only migration; do not run a full db push against the manual ledger.
begin;
create table public.inventory_adjustments (
  id uuid primary key default gen_random_uuid(),
  adjustment_no text not null unique,
  warehouse_id uuid not null references public.warehouses(id),
  occurred_on date not null,
  note text not null default '',
  posted_by uuid not null references public.app_accounts(id),
  posted_at timestamptz not null default now(),
  posting_id uuid not null unique references public.inventory_postings(id)
);
create table public.inventory_adjustment_lines (
  id uuid primary key default gen_random_uuid(),
  adjustment_id uuid not null references public.inventory_adjustments(id),
  item_id uuid not null references public.uniform_items(id),
  item_code_snapshot text not null,
  item_name_snapshot text not null,
  quantity_delta bigint not null check (quantity_delta <> 0 and abs(quantity_delta) <= 10000000),
  quantity_before bigint not null check (quantity_before >= 0),
  quantity_after bigint not null check (quantity_after >= 0),
  reason text not null check (btrim(reason) <> '' and length(reason) <= 500),
  unique (adjustment_id, item_id),
  check (quantity_after = quantity_before + quantity_delta)
);
alter table public.inventory_postings drop constraint inventory_postings_posting_kind_check;
alter table public.inventory_postings add constraint inventory_postings_posting_kind_check
  check (posting_kind in ('OPENING','WAREHOUSE_SHIPMENT','REPLENISHMENT','RECEIPT','STOCKTAKE','CORRECTION','RETURN','ADJUSTMENT'));
alter table public.inventory_adjustments enable row level security;
alter table public.inventory_adjustment_lines enable row level security;
create policy inventory_adjustments_read on public.inventory_adjustments for select to authenticated
  using (private.has_role('HR') or private.has_role('WAREHOUSE'));
create policy inventory_adjustment_lines_read on public.inventory_adjustment_lines for select to authenticated
  using (private.has_role('HR') or private.has_role('WAREHOUSE'));
revoke all on public.inventory_adjustments, public.inventory_adjustment_lines from public, anon, authenticated;
grant select on public.inventory_adjustments, public.inventory_adjustment_lines to authenticated;
create index inventory_adjustment_lines_item_idx on public.inventory_adjustment_lines(item_id);
create index inventory_adjustments_warehouse_date_idx on public.inventory_adjustments(warehouse_id, posted_at desc);
create trigger inventory_adjustments_append_only before update or delete on public.inventory_adjustments
  for each row execute function private.reject_append_only_mutation();
create trigger inventory_adjustment_lines_append_only before update or delete on public.inventory_adjustment_lines
  for each row execute function private.reject_append_only_mutation();
create trigger audit_inventory_adjustments after insert on public.inventory_adjustments
  for each row execute function private.audit_business_row_change();
create trigger audit_inventory_adjustment_lines after insert on public.inventory_adjustment_lines
  for each row execute function private.audit_business_row_change();

create function public.complete_inventory_adjustment(
  p_warehouse_id uuid, p_occurred_on date, p_note text, p_lines jsonb, p_idempotency_key text
) returns public.inventory_adjustments
language plpgsql security definer set search_path = pg_catalog, private
as $$
declare
  actor uuid := private.current_account_id();
  command public.operation_commands%rowtype;
  result public.inventory_adjustments%rowtype;
  warehouse public.warehouses%rowtype;
  item public.uniform_items%rowtype;
  line record;
  before_quantity bigint;
  combined_quantity numeric;
  reserved_quantity numeric;
  fingerprint text;
  doc_id uuid := gen_random_uuid();
  posting uuid := gen_random_uuid();
  line_number integer := 0;
begin
  if actor is null then raise exception using errcode = '42501', message = 'ADJUSTMENT_UNAUTHORIZED'; end if;
  select * into warehouse from public.warehouses w where w.id = p_warehouse_id and w.is_active;
  if not found or not ((warehouse.purpose = 'HR' and private.has_role('HR')) or
    (warehouse.purpose = 'GENERAL' and private.has_role('WAREHOUSE'))) then
    raise exception using errcode = '42501', message = 'ADJUSTMENT_UNAUTHORIZED';
  end if;
  if p_occurred_on is null or length(coalesce(p_note,'')) > 2000
    or btrim(coalesce(p_idempotency_key,'')) = '' or length(p_idempotency_key) > 100
    or jsonb_typeof(p_lines) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'ADJUSTMENT_INVALID_INPUT';
  end if;
  if jsonb_array_length(p_lines) not between 1 and 1000 then
    raise exception using errcode = '22023', message = 'ADJUSTMENT_INVALID_INPUT';
  end if;
  for line in select value as value from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(line.value) is distinct from 'object'
      or coalesce(line.value->>'item_id','') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      or coalesce(line.value->>'quantity_delta','') !~ '^-?[0-9]{1,8}$'
      or btrim(coalesce(line.value->>'reason','')) = '' or length(line.value->>'reason') > 500 then
      raise exception using errcode = '22023', message = 'ADJUSTMENT_INVALID_INPUT';
    end if;
    if abs((line.value->>'quantity_delta')::bigint) not between 1 and 10000000 then
      raise exception using errcode = '22023', message = 'ADJUSTMENT_INVALID_INPUT';
    end if;
  end loop;
  if (select count(distinct (value->>'item_id')::uuid) from jsonb_array_elements(p_lines)) <> jsonb_array_length(p_lines) then
    raise exception using errcode = '22023', message = 'ADJUSTMENT_DUPLICATE_ITEM';
  end if;
  -- Compare the actual complete request, not a browser-supplied fingerprint.
  fingerprint := jsonb_build_object('warehouse',p_warehouse_id,'date',p_occurred_on,'note',coalesce(p_note,''),'lines',p_lines)::text;
  insert into public.operation_commands(operation_code,idempotency_key,canonical_request_fingerprint,actor_account_id)
    values ('COMPLETE_INVENTORY_ADJUSTMENT',p_idempotency_key,fingerprint,actor)
    on conflict on constraint operation_commands_operation_code_idempotency_key_key do nothing;
  select * into command from public.operation_commands c
    where c.operation_code = 'COMPLETE_INVENTORY_ADJUSTMENT' and c.idempotency_key = p_idempotency_key for update;
  if command.actor_account_id <> actor or command.canonical_request_fingerprint <> fingerprint then
    raise exception using errcode = '22023', message = 'ADJUSTMENT_RETRY_MISMATCH';
  end if;
  if command.status = 'SUCCEEDED' then
    select * into strict result from public.inventory_adjustments a where a.id = command.result_entity_id;
    return result;
  end if;
  insert into public.inventory_item_locks(item_id)
    select (value->>'item_id')::uuid from jsonb_array_elements(p_lines) order by 1 on conflict do nothing;
  perform l.item_id from public.inventory_item_locks l
    where l.item_id in (select (value->>'item_id')::uuid from jsonb_array_elements(p_lines)) order by l.item_id for update;
  -- Validate and lock active master rows after acquiring the common inventory locks.
  perform w.id from public.warehouses w where w.id = p_warehouse_id and w.is_active for share;
  if not found then raise exception using errcode='22023', message='ADJUSTMENT_INVALID_WAREHOUSE'; end if;
  for line in select (value->>'item_id')::uuid as item_id, (value->>'quantity_delta')::bigint as delta,
    value->>'reason' as reason from jsonb_array_elements(p_lines) order by 1 loop
    select * into item from public.uniform_items i where i.id = line.item_id and i.is_active for share;
    if not found then raise exception using errcode='22023', message='ADJUSTMENT_INVALID_ITEM'; end if;
    insert into public.inventory_balances(warehouse_id,item_id,on_hand_quantity,version)
      values(p_warehouse_id,line.item_id,0,0) on conflict do nothing;
    select b.on_hand_quantity into before_quantity from public.inventory_balances b
      where b.warehouse_id=p_warehouse_id and b.item_id=line.item_id for update;
    if before_quantity::numeric + line.delta < 0 then
      raise exception using errcode='23514', message='ADJUSTMENT_INSUFFICIENT_STOCK';
    end if;
    select coalesce(sum(b.on_hand_quantity),0) into combined_quantity from public.inventory_balances b
      join public.warehouses w on w.id=b.warehouse_id where b.item_id=line.item_id and w.is_active and w.purpose in ('HR','GENERAL');
    select coalesce(sum(r.quantity),0) into reserved_quantity from public.inventory_reservations r where r.item_id=line.item_id and r.status='ACTIVE';
    if line.delta < 0 and combined_quantity + line.delta < reserved_quantity then
      raise exception using errcode='23514', message='ADJUSTMENT_RESERVED_STOCK';
    end if;
  end loop;
  insert into public.inventory_postings(id,idempotency_key,posting_kind,source_entity_id,posted_by)
    values(posting,'ADJUSTMENT:' || p_idempotency_key,'ADJUSTMENT',doc_id,actor);
  insert into public.inventory_adjustments(id,adjustment_no,warehouse_id,occurred_on,note,posted_by,posting_id)
    values(doc_id,'ADJ-' || to_char(clock_timestamp(),'YYYYMMDDHH24MISSMS') || '-' || upper(substr(doc_id::text,1,8)),
      p_warehouse_id,p_occurred_on,coalesce(p_note,''),actor,posting) returning * into result;
  for line in select (value->>'item_id')::uuid as item_id,(value->>'quantity_delta')::bigint as delta,
    value->>'reason' as reason from jsonb_array_elements(p_lines) order by 1 loop
    line_number := line_number + 1;
    select * into strict item from public.uniform_items i where i.id=line.item_id;
    select b.on_hand_quantity into strict before_quantity from public.inventory_balances b where b.warehouse_id=p_warehouse_id and b.item_id=line.item_id;
    insert into public.inventory_adjustment_lines(adjustment_id,item_id,item_code_snapshot,item_name_snapshot,quantity_delta,quantity_before,quantity_after,reason)
      values(doc_id,item.id,item.item_code,item.item_name,line.delta,before_quantity,before_quantity+line.delta,line.reason);
    insert into public.inventory_ledger_entries(posting_id,line_no,warehouse_id,item_id,movement_kind,quantity_delta,occurred_on)
      values(posting,line_number,p_warehouse_id,item.id,'MANUAL_ADJUSTMENT',line.delta,p_occurred_on);
    update public.inventory_balances b set on_hand_quantity=b.on_hand_quantity+line.delta,version=b.version+1,last_posting_id=posting,updated_at=now()
      where b.warehouse_id=p_warehouse_id and b.item_id=item.id;
  end loop;
  update public.operation_commands c set status='SUCCEEDED',result_entity_type='inventory_adjustments',result_entity_id=doc_id,succeeded_at=now() where c.id=command.id;
  return result;
end;
$$;
revoke all on function public.complete_inventory_adjustment(uuid,date,text,jsonb,text) from public,anon;
grant execute on function public.complete_inventory_adjustment(uuid,date,text,jsonb,text) to authenticated;

-- Preserve the existing security-invoker report contract and append the new source number.
create or replace view public.v_inventory_history with (security_invoker=true) as
with ordered_entries as (
  select le.id as ledger_entry_id,le.posting_id,le.line_no,le.warehouse_id,le.item_id,le.movement_kind,le.quantity_delta,le.occurred_on,
    p.posting_kind,p.source_entity_id,p.idempotency_key,p.posted_by,p.posted_at,
    coalesce(a.display_name,a.email_snapshot) as posted_by_name,w.code as warehouse_code,w.name as warehouse_name,w.purpose as warehouse_purpose,
    i.item_code,i.item_name,i.unit,b.on_hand_quantity as current_on_hand_quantity,
    case p.posting_kind
      when 'ADJUSTMENT' then (select x.adjustment_no from public.inventory_adjustments x where x.id=p.source_entity_id)
      when 'WAREHOUSE_SHIPMENT' then (select x.shipment_no from public.warehouse_shipments x where x.id=p.source_entity_id)
      when 'REPLENISHMENT' then (select x.request_no from public.replenishment_requests x where x.id=p.source_entity_id)
      when 'RECEIPT' then (select x.receipt_no from public.purchase_receipts x where x.id=p.source_entity_id)
      when 'STOCKTAKE' then (select x.stocktake_no from public.stocktakes x where x.id=p.source_entity_id)
      when 'RETURN' then (select x.return_no from public.return_notes x where x.id=p.source_entity_id)
      when 'OPENING' then (select x.batch_no from public.opening_posting_sources s join public.opening_balance_batches x on x.id=s.batch_id where s.posting_id=p.id)
      when 'CORRECTION' then (select x.correction_no from public.correction_posting_sources s join public.correction_notes x on x.id=s.correction_note_id where s.posting_id=p.id)
      else null end as source_no,
    coalesce(sum(le.quantity_delta) over(partition by le.warehouse_id,le.item_id order by p.posted_at,p.id,le.line_no rows between 1 following and unbounded following),0)::bigint as future_quantity_delta
  from public.inventory_ledger_entries le join public.inventory_postings p on p.id=le.posting_id
    join public.warehouses w on w.id=le.warehouse_id join public.uniform_items i on i.id=le.item_id
    left join public.app_accounts a on a.id=p.posted_by
    left join public.inventory_balances b on b.warehouse_id=le.warehouse_id and b.item_id=le.item_id
)
select ledger_entry_id,posting_id,line_no,warehouse_id,warehouse_code,warehouse_name,warehouse_purpose,item_id,item_code,item_name,unit,
  posting_kind,movement_kind,quantity_delta,occurred_on,source_entity_id,idempotency_key,posted_by,posted_by_name,posted_at,
  (current_on_hand_quantity-future_quantity_delta)::bigint as on_hand_after_entry,current_on_hand_quantity,source_no from ordered_entries;
notify pgrst,'reload schema';
commit;
