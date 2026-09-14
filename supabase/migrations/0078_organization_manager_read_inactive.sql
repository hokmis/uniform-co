begin;

-- Existing active-read policies remain intact for every role that currently
-- consumes organization selectors. HR is the only role allowed by
-- apply_master_import to maintain institutions and departments, so this
-- additive policy lets HR inspect inactive rows for review/reactivation.
drop policy if exists institutions_management_read on public.institutions;

create policy institutions_management_read
on public.institutions
for select
to authenticated
using (
  private.current_account_id() is not null
  and private.has_role('HR')
);

drop policy if exists departments_management_read on public.departments;

create policy departments_management_read
on public.departments
for select
to authenticated
using (
  private.current_account_id() is not null
  and private.has_role('HR')
);

commit;
