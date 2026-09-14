-- Forward-fix the correction source immutability guard after STOCKTAKE added
-- original_stocktake_id to correction_notes. Existing deployed databases must
-- replace the trigger function rather than relying on 0054/0055 replays.

create or replace function private.prevent_posted_correction_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  if tg_table_name = 'correction_notes' then
    if old.status = 'POSTED' then
      raise exception 'Posted corrections are immutable';
    end if;
    if tg_op = 'DELETE' then
      return old;
    end if;
    if old.correction_kind is distinct from new.correction_kind
       or old.original_purchase_receipt_id is distinct from new.original_purchase_receipt_id
       or old.original_return_note_id is distinct from new.original_return_note_id
       or old.original_hr_request_id is distinct from new.original_hr_request_id
       or old.original_warehouse_shipment_id is distinct from new.original_warehouse_shipment_id
       or old.original_replenishment_request_id is distinct from new.original_replenishment_request_id
       or old.original_stocktake_id is distinct from new.original_stocktake_id then
      raise exception 'Correction source cannot be changed';
    end if;
  elsif exists (
    select 1
    from public.correction_notes c
    where c.id = old.correction_note_id
      and c.status = 'POSTED'
  ) then
    raise exception 'Posted correction lines are immutable';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
