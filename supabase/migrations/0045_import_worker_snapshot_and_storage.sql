-- Durable import worker read seams.
-- The worker never receives broad table DML or a project service key: it polls
-- through a narrow RPC, obtains a type-specific immutable comparison snapshot,
-- and reads only its own fixed Storage object through the protected proxy.

create table if not exists public.import_batch_reference_snapshots (
  batch_id uuid primary key references public.import_batches(id) on delete restrict,
  snapshot jsonb not null,
  snapshot_sha256 text not null check (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);
alter table public.import_batch_reference_snapshots enable row level security;
alter table public.import_batch_reference_snapshots force row level security;
revoke all on public.import_batch_reference_snapshots from public, anon, authenticated;

create or replace function public.list_import_work(p_limit integer default 10)
returns setof public.import_batches
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  actor_id uuid;
begin
  actor_id := private.require_import_worker();
  if p_limit is null or p_limit < 1 or p_limit > 50 then
    raise exception 'Import work limit is invalid' using errcode = '22023';
  end if;
  return query
  select b.*
  from public.import_batches b
  where b.status in ('AWAITING_UPLOAD', 'UPLOADED', 'PARSING', 'VALIDATING', 'VALIDATED', 'APPLYING')
  order by b.created_at, b.id
  limit p_limit;
end;
$$;

create or replace function public.get_import_reference_snapshot(p_batch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  actor_id uuid;
  batch_row public.import_batches;
  payload jsonb;
  snapshot_row public.import_batch_reference_snapshots;
begin
  actor_id := private.require_import_worker();
  select * into batch_row from public.import_batches where id = p_batch_id for update;
  if not found or batch_row.status in ('APPLIED', 'FAILED', 'CANCELLED') then
    raise exception 'Import batch is not available for preview' using errcode = '55000';
  end if;
  select * into snapshot_row from public.import_batch_reference_snapshots where batch_id = p_batch_id;
  if found then
    return snapshot_row.snapshot;
  end if;
  if batch_row.import_type = 'INSTITUTIONS' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'kind', 'INSTITUTION', 'code', i.code, 'name', i.name, 'isActive', i.is_active
    ) order by i.code), '[]'::jsonb) into payload from public.institutions i;
  elsif batch_row.import_type = 'DEPARTMENTS' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'kind', 'DEPARTMENT', 'institutionCode', i.code, 'code', d.code, 'name', d.name, 'isActive', d.is_active
    ) order by i.code, d.code), '[]'::jsonb) into payload
    from public.departments d join public.institutions i on i.id = d.institution_id;
  elsif batch_row.import_type = 'EMPLOYEES' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'kind', 'EMPLOYEE', 'employeeNo', e.employee_no, 'name', e.name,
      'institutionCode', i.code, 'departmentCode', d.code,
      'employmentStatus', e.employment_status, 'jobTitle', e.job_title,
      'hireDate', e.hire_date, 'terminationDate', e.termination_date, 'note', e.note
    ) order by e.employee_no), '[]'::jsonb) into payload
    from public.employees e
    join public.institutions i on i.id = e.institution_id
    join public.departments d on d.id = e.department_id;
  elsif batch_row.import_type = 'UNIFORM_ITEMS' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'kind', 'UNIFORM_ITEM', 'code', i.item_code, 'name', i.item_name, 'unit', i.unit,
      'size', i.size, 'category', i.category, 'season', i.season, 'isActive', i.is_active
    ) order by i.item_code), '[]'::jsonb) into payload from public.uniform_items i;
  elsif batch_row.import_type = 'SUPPLIERS' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'kind', 'SUPPLIER', 'supplierCode', s.supplier_code, 'name', s.name,
      'defaultCurrency', s.default_currency, 'isActive', s.is_active
    ) order by s.supplier_code), '[]'::jsonb) into payload from public.suppliers s;
  elsif batch_row.import_type = 'SUPPLIER_ITEMS' then
    select coalesce(jsonb_agg(jsonb_build_object(
      'kind', 'SUPPLIER_ITEM', 'supplierCode', s.supplier_code, 'itemCode', i.item_code,
      'minimumOrderQuantity', si.minimum_order_quantity::text,
      'supplierItemCode', si.supplier_item_code, 'isActive', si.is_active
    ) order by s.supplier_code, i.item_code), '[]'::jsonb) into payload
    from public.supplier_uniform_items si
    join public.suppliers s on s.id = si.supplier_id
    join public.uniform_items i on i.id = si.item_id;
  elsif batch_row.import_type = 'OPENING_BALANCE' then
    select coalesce(jsonb_agg(jsonb_build_object('kind', 'WAREHOUSE', 'code', w.code, 'name', w.name, 'purpose', w.purpose, 'isActive', w.is_active) order by w.code), '[]'::jsonb) into payload from public.warehouses w;
    select payload || coalesce(jsonb_agg(jsonb_build_object('kind', 'UNIFORM_ITEM', 'code', i.item_code, 'name', i.item_name, 'unit', i.unit, 'isActive', i.is_active) order by i.item_code), '[]'::jsonb) into payload from public.uniform_items i;
  else
    payload := '[]'::jsonb;
  end if;
  if batch_row.import_type = 'DEPARTMENTS' then
    select payload || coalesce(jsonb_agg(jsonb_build_object('kind', 'INSTITUTION', 'code', i.code, 'name', i.name, 'isActive', i.is_active) order by i.code), '[]'::jsonb) into payload from public.institutions i;
  elsif batch_row.import_type = 'EMPLOYEES' then
    select payload || coalesce(jsonb_agg(jsonb_build_object('kind', 'INSTITUTION', 'code', i.code, 'name', i.name, 'isActive', i.is_active) order by i.code), '[]'::jsonb) into payload from public.institutions i;
    select payload || coalesce(jsonb_agg(jsonb_build_object('kind', 'DEPARTMENT', 'institutionCode', i.code, 'code', d.code, 'name', d.name, 'isActive', d.is_active) order by i.code, d.code), '[]'::jsonb) into payload from public.departments d join public.institutions i on i.id = d.institution_id;
  elsif batch_row.import_type = 'SUPPLIER_ITEMS' then
    select payload || coalesce(jsonb_agg(jsonb_build_object('kind', 'SUPPLIER', 'supplierCode', s.supplier_code, 'name', s.name, 'isActive', s.is_active) order by s.supplier_code), '[]'::jsonb) into payload from public.suppliers s;
    select payload || coalesce(jsonb_agg(jsonb_build_object('kind', 'UNIFORM_ITEM', 'code', i.item_code, 'name', i.item_name, 'unit', i.unit, 'isActive', i.is_active) order by i.item_code), '[]'::jsonb) into payload from public.uniform_items i;
  end if;
  payload := jsonb_build_object('batch_id', batch_row.id, 'import_type', batch_row.import_type, 'rows', payload);
  insert into public.import_batch_reference_snapshots(batch_id, snapshot, snapshot_sha256)
  values (batch_row.id, payload, encode(digest(payload::text, 'sha256'), 'hex'));
  return payload;
end;
$$;

create or replace function private.import_storage_capability(
  p_batch_id uuid,
  p_bucket_id text,
  p_object_key text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  if session_user <> 'job_renderer_storage_proxy'
     or p_batch_id is null or p_bucket_id <> 'uniform-imports'
     or p_object_key is null or p_object_key like '%..%' or left(p_object_key, 1) = '/' then
    return false;
  end if;
  return exists (
    select 1 from public.import_batches b
    where b.id = p_batch_id
      and b.storage_bucket = p_bucket_id
      and b.storage_object_key = p_object_key
      and b.status in ('AWAITING_UPLOAD', 'UPLOADED', 'PARSING', 'VALIDATING', 'VALIDATED', 'APPLYING')
  );
end;
$$;

revoke all on function public.list_import_work(integer) from public, anon, authenticated;
revoke all on function public.get_import_reference_snapshot(uuid) from public, anon, authenticated;
revoke all on function private.import_storage_capability(uuid, text, text) from public, anon, authenticated;
grant execute on function public.list_import_work(integer) to job_import_worker;
grant execute on function public.get_import_reference_snapshot(uuid) to job_import_worker;
grant usage on schema private to job_renderer_storage_proxy;
grant execute on function private.import_storage_capability(uuid, text, text) to job_renderer_storage_proxy;
