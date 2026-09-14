begin;

-- Active items remain readable by every authenticated application account.
-- HR is the only role allowed by apply_master_import to maintain UNIFORM_ITEMS,
-- so it also needs read access to inactive rows in order to review/reactivate
-- them from the product management interface.
drop policy if exists uniform_items_active_read on public.uniform_items;
drop policy if exists uniform_items_catalog_read on public.uniform_items;

create policy uniform_items_catalog_read
on public.uniform_items
for select
to authenticated
using (
  private.current_account_id() is not null
  and (
    is_active
    or private.has_role('HR')
  )
);

commit;

