-- A cancelled or revised HR request must not leave an unposted warehouse draft behind.
-- Posted shipments remain immutable and are never removed by this cleanup.

create or replace function private.cleanup_hr_request_draft_shipment_on_cancel()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  if (
    old.status <> 'CANCELLED' and new.status = 'CANCELLED'
  ) or (
    old.status in ('SUBMITTED', 'INVENTORY_REVIEW_REQUIRED') and new.status = 'DRAFT'
  ) then
    delete from public.warehouse_shipment_lines l
    using public.warehouse_shipments s
    where s.id = l.shipment_id
      and s.hr_request_id = new.id
      and s.status = 'DRAFT';

    delete from public.warehouse_shipments s
    where s.hr_request_id = new.id
      and s.status = 'DRAFT';
  end if;

  return new;
end;
$$;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_trigger t
    where t.tgrelid = 'public.hr_requests'::pg_catalog.regclass
      and t.tgname = 'hr_request_cancel_draft_shipment_cleanup'
      and not t.tgisinternal
  ) then
    execute 'create trigger hr_request_cancel_draft_shipment_cleanup
      after update of status on public.hr_requests
      for each row execute function private.cleanup_hr_request_draft_shipment_on_cancel()';
  end if;
end;
$$;
