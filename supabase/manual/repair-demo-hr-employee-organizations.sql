-- 修復已存在的示範資料異常：在職 DEMO 員工所屬機構被停用。
-- 僅限確認 DEMO-A／DEMO-B 是示範機構時執行；不要套用到真實機構代碼。

begin;

update public.institutions i
set is_active = true
where i.code in ('DEMO-A', 'DEMO-B')
  and i.is_active = false
  and exists (
    select 1
    from public.employees e
    where e.institution_id = i.id
      and e.employment_status = 'ACTIVE'
  );

update public.departments d
set is_active = true
where d.is_active = false
  and exists (
    select 1
    from public.employees e
    where e.institution_id = d.institution_id
      and e.department_id = d.id
      and e.employment_status = 'ACTIVE'
  );

commit;

-- 驗證：以下應回傳 0。
select count(*) as active_employees_under_inactive_institution
from public.employees e
join public.institutions i on i.id = e.institution_id
where e.employment_status = 'ACTIVE' and not i.is_active;
