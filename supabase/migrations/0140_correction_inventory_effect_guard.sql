begin;

-- A correction may enter POSTED only after its immutable ledger and every
-- corresponding balance row prove that the same posting was applied.
create or replace function private.assert_correction_inventory_effect()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  v_posting_id uuid;
  posting_count integer;
  line_count integer;
  ledger_count integer;
  balance_count integer;
  transfer_line public.warehouse_transfer_correction_lines;
  stocktake_line public.stocktake_correction_lines;
  stocktake_row public.stocktakes;
begin
  if old.status is distinct from 'DRAFT'
     or new.status is distinct from 'POSTED'
     or new.correction_kind not in ('WAREHOUSE_TRANSFER', 'STOCKTAKE') then
    return new;
  end if;

  select count(*)::integer
  into posting_count
  from public.correction_posting_sources cps
  join public.inventory_postings p on p.id = cps.posting_id
  where cps.correction_note_id = new.id
    and p.posting_kind = 'CORRECTION'
    and p.source_entity_id = new.id;

  if posting_count <> 1 then
    raise exception using errcode = '23514', message = 'Correction inventory ledger is incomplete';
  end if;

  select p.id
  into v_posting_id
  from public.correction_posting_sources cps
  join public.inventory_postings p on p.id = cps.posting_id
  where cps.correction_note_id = new.id
    and p.posting_kind = 'CORRECTION'
    and p.source_entity_id = new.id
  limit 1;

  if new.correction_kind = 'WAREHOUSE_TRANSFER' then
    select count(*)::integer into line_count
    from public.warehouse_transfer_correction_lines
    where correction_note_id = new.id;
    if line_count <> 1 then
      raise exception using errcode = '23514', message = 'Correction inventory ledger is incomplete';
    end if;

    select * into transfer_line
    from public.warehouse_transfer_correction_lines
    where correction_note_id = new.id
    limit 1;

    select count(*)::integer into ledger_count
    from public.inventory_ledger_entries le
    where le.posting_id = v_posting_id;

    if ledger_count <> 2
       or not exists (
         select 1
         from public.inventory_ledger_entries le
         join public.warehouses w on w.id = le.warehouse_id
         where le.posting_id = v_posting_id
           and le.line_no = 1
           and w.purpose = 'GENERAL'
           and le.item_id = transfer_line.item_id
           and le.movement_kind = 'WAREHOUSE_TRANSFER_CORRECTION_OUT'
           and le.quantity_delta = -transfer_line.transfer_quantity_delta
       )
       or not exists (
         select 1
         from public.inventory_ledger_entries le
         join public.warehouses w on w.id = le.warehouse_id
         where le.posting_id = v_posting_id
           and le.line_no = 2
           and w.purpose = 'HR'
           and le.item_id = transfer_line.item_id
           and le.movement_kind = 'WAREHOUSE_TRANSFER_CORRECTION_IN'
           and le.quantity_delta = transfer_line.transfer_quantity_delta
       ) then
      raise exception using errcode = '23514', message = 'Correction inventory ledger is incomplete';
    end if;

    select count(*)::integer into balance_count
    from public.inventory_ledger_entries le
    join public.inventory_balances b
      on b.item_id = le.item_id
     and b.warehouse_id = le.warehouse_id
     and b.last_posting_id = le.posting_id
    where le.posting_id = v_posting_id
      and le.item_id = transfer_line.item_id;

    if balance_count <> 2 then
      raise exception using errcode = '23514', message = 'Correction inventory balance update is incomplete';
    end if;

    return new;
  end if;

  select count(*)::integer into line_count
  from public.stocktake_correction_lines
  where correction_note_id = new.id;
  if line_count <> 1 then
    raise exception using errcode = '23514', message = 'Correction inventory ledger is incomplete';
  end if;

  select * into stocktake_line
  from public.stocktake_correction_lines
  where correction_note_id = new.id
  limit 1;

  select * into stocktake_row
  from public.stocktakes
  where id = stocktake_line.original_stocktake_id;

  if stocktake_row.id is null then
    raise exception using errcode = '23514', message = 'Correction inventory ledger is incomplete';
  end if;

  select count(*)::integer into ledger_count
  from public.inventory_ledger_entries le
  where le.posting_id = v_posting_id;

  if ledger_count <> 1
     or not exists (
       select 1
       from public.inventory_ledger_entries le
       where le.posting_id = v_posting_id
         and le.line_no = 1
         and le.warehouse_id = stocktake_row.warehouse_id
         and le.item_id = stocktake_line.item_id
         and le.movement_kind = 'STOCKTAKE_CORRECTION'
         and le.quantity_delta = stocktake_line.counted_quantity_delta
     ) then
    raise exception using errcode = '23514', message = 'Correction inventory ledger is incomplete';
  end if;

  select count(*)::integer into balance_count
  from public.inventory_balances b
  where b.warehouse_id = stocktake_row.warehouse_id
    and b.item_id = stocktake_line.item_id
    and b.last_posting_id = v_posting_id;

  if balance_count <> 1 then
    raise exception using errcode = '23514', message = 'Correction inventory balance update is incomplete';
  end if;

  return new;
end;
$$;

drop trigger if exists correction_notes_inventory_effect_guard on public.correction_notes;
create trigger correction_notes_inventory_effect_guard
before update of status on public.correction_notes
for each row
execute function private.assert_correction_inventory_effect();

revoke all on function private.assert_correction_inventory_effect() from public, anon, authenticated;

comment on function private.assert_correction_inventory_effect()
  is 'Rejects transfer/stocktake correction completion unless its ledger and balance rows prove the same inventory posting.';

commit;
