-- DEMO / disposable staging only.
-- This script never replaces an existing active warehouse. It creates the
-- required HR and GENERAL purposes only when that purpose has no active row.
-- Do not run this file in production: use the company's approved warehouse
-- codes and names there.

begin;

insert into public.warehouses (code, name, purpose, is_active)
select 'DEMO-HR', '人資倉', 'HR', true
where not exists (
  select 1 from public.warehouses
  where purpose = 'HR' and is_active
)
and not exists (
  select 1 from public.warehouses
  where code = 'DEMO-HR'
);

insert into public.warehouses (code, name, purpose, is_active)
select 'DEMO-GENERAL', '總倉', 'GENERAL', true
where not exists (
  select 1 from public.warehouses
  where purpose = 'GENERAL' and is_active
)
and not exists (
  select 1 from public.warehouses
  where code = 'DEMO-GENERAL'
);

commit;

select code, name, purpose, is_active
from public.warehouses
where purpose in ('HR', 'GENERAL')
order by purpose;
