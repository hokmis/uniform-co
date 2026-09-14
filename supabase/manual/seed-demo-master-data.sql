-- DEMO / disposable staging only.
-- The DEMO-* namespace makes these rows easy to identify and remove from a
-- disposable project. This is a convenience seed for SQL Editor; production
-- data must be reviewed and imported through the protected website workflow.
-- This script does not create inventory balances or publish opening balance.

begin;

insert into public.institutions (code, name, is_active)
values
  ('DEMO-A', '範例機構 A', true),
  ('DEMO-B', '範例機構 B', true)
on conflict (code) do update
set name = excluded.name, is_active = excluded.is_active;

insert into public.departments (institution_id, code, name, is_active)
select i.id, v.department_code, v.department_name, true
from (values
  ('DEMO-A', 'ADMIN', '行政部門'),
  ('DEMO-A', 'OPS', '作業部門'),
  ('DEMO-B', 'ADMIN', '行政部門')
) as v(institution_code, department_code, department_name)
join public.institutions i on i.code = v.institution_code
on conflict (institution_id, code) do update
set name = excluded.name, is_active = excluded.is_active;

insert into public.uniform_items (item_code, item_name, unit, size, category, season, is_active)
values
  ('DEMO-SHIRT-M', '範例短袖上衣', '件', 'M', '上衣', '全年', true),
  ('DEMO-SHIRT-L', '範例短袖上衣', '件', 'L', '上衣', '全年', true),
  ('DEMO-PANTS-M', '範例長褲', '件', 'M', '下身', '全年', true),
  ('DEMO-PANTS-L', '範例長褲', '件', 'L', '下身', '全年', true)
on conflict (item_code) do update
set item_name = excluded.item_name,
    unit = excluded.unit,
    size = excluded.size,
    category = excluded.category,
    season = excluded.season,
    is_active = excluded.is_active;

insert into public.suppliers (supplier_code, name, default_currency, is_active)
values ('DEMO-SUPPLIER', '範例制服供應商', 'TWD', true)
on conflict (supplier_code) do update
set name = excluded.name,
    default_currency = excluded.default_currency,
    is_active = excluded.is_active;

insert into public.supplier_uniform_items (
  supplier_id, item_id, minimum_order_quantity, supplier_item_code, is_active
)
select s.id, i.id, v.minimum_order_quantity, v.supplier_item_code, true
from (values
  ('DEMO-SUPPLIER', 'DEMO-SHIRT-M', 10::bigint, 'DS-M'),
  ('DEMO-SUPPLIER', 'DEMO-SHIRT-L', 10::bigint, 'DS-L'),
  ('DEMO-SUPPLIER', 'DEMO-PANTS-M', 10::bigint, 'DP-M'),
  ('DEMO-SUPPLIER', 'DEMO-PANTS-L', 10::bigint, 'DP-L')
) as v(supplier_code, item_code, minimum_order_quantity, supplier_item_code)
join public.suppliers s on s.supplier_code = v.supplier_code
join public.uniform_items i on i.item_code = v.item_code
on conflict (supplier_id, item_id) do update
set minimum_order_quantity = excluded.minimum_order_quantity,
    supplier_item_code = excluded.supplier_item_code,
    is_active = excluded.is_active;

insert into public.employees (
  employee_no, name, institution_id, department_id, employment_status
)
select v.employee_no, v.employee_name, i.id, d.id, 'ACTIVE'
from (values
  ('DEMO-E001', '範例員工一', 'DEMO-A', 'ADMIN'),
  ('DEMO-E002', '範例員工二', 'DEMO-A', 'OPS'),
  ('DEMO-E003', '範例員工三', 'DEMO-B', 'ADMIN')
) as v(employee_no, employee_name, institution_code, department_code)
join public.institutions i on i.code = v.institution_code
join public.departments d
  on d.institution_id = i.id
 and d.code = v.department_code
on conflict (employee_no) do update
set name = excluded.name,
    institution_id = excluded.institution_id,
    department_id = excluded.department_id,
    employment_status = excluded.employment_status;

commit;

select
  (select count(*) from public.institutions where code like 'DEMO-%') as demo_institutions,
  (select count(*) from public.departments where code in ('ADMIN', 'OPS')) as demo_departments,
  (select count(*) from public.uniform_items where item_code like 'DEMO-%') as demo_uniform_items,
  (select count(*) from public.suppliers where supplier_code = 'DEMO-SUPPLIER') as demo_suppliers,
  (select count(*) from public.employees where employee_no like 'DEMO-%') as demo_employees;
