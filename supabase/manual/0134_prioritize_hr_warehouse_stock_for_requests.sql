-- Manual 0134: Prioritize HR warehouse stock for uniform requests
-- Drops expression on hr_request_items.requested_transfer_quantity
-- and installs trigger to calculate requested transfer quantity as:
-- greatest(0, issue_quantity - hr_on_hand) + increase_quantity
-- so HR warehouse stock is deducted first before transferring from GENERAL.

begin;

-- 1. Relax check constraint on inventory_reservations to allow 0 quantity when no transfer needed
alter table public.inventory_reservations
  drop constraint if exists inventory_reservations_quantity_check;

alter table public.inventory_reservations
  add constraint inventory_reservations_quantity_check check (quantity >= 0);

-- 2. Drop generated expression on hr_request_items.requested_transfer_quantity
alter table public.hr_request_items
  alter column requested_transfer_quantity drop expression;

-- 3. Create or replace trigger function to calculate requested_transfer_quantity prioritizing HR warehouse
create or replace function public.calculate_hr_request_item_transfer_quantity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_hr_on_hand bigint;
begin
  select coalesce(b.on_hand_quantity, 0) into v_hr_on_hand
  from public.inventory_balances b
  join public.warehouses w on w.id = b.warehouse_id
  where b.item_id = NEW.item_id and w.purpose = 'HR' and w.is_active
  limit 1;

  NEW.requested_transfer_quantity := greatest(0, NEW.issue_quantity - coalesce(v_hr_on_hand, 0)) + NEW.increase_quantity;
  return NEW;
end;
$$;

-- 4. Attach trigger on hr_request_items
drop trigger if exists trg_hr_request_items_transfer_quantity on public.hr_request_items;

create trigger trg_hr_request_items_transfer_quantity
before insert or update of issue_quantity, increase_quantity on public.hr_request_items
for each row
execute function public.calculate_hr_request_item_transfer_quantity();

-- 5. Backfill existing hr_request_items
update public.hr_request_items ri
set requested_transfer_quantity = greatest(
  0,
  ri.issue_quantity - coalesce((
    select b.on_hand_quantity
    from public.inventory_balances b
    join public.warehouses w on w.id = b.warehouse_id
    where b.item_id = ri.item_id and w.purpose = 'HR' and w.is_active
    limit 1
  ), 0)
) + ri.increase_quantity;

commit;
