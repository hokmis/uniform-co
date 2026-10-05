begin;

create or replace function private.prevent_posted_replenishment_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  -- Cancellation may change only cancellation metadata, never submitted content.
  if tg_op = 'UPDATE' and old.status = 'SUBMITTED' and new.status = 'CANCELLED'
     and auth.uid() is not null and auth.jwt() ->> 'role' = 'authenticated'
     and private.has_role('HR')
     and new.cancelled_by = private.current_account_id()
     and new.cancelled_at is not null
     and btrim(coalesce(new.cancellation_reason, '')) <> ''
     and new.row_version = old.row_version + 1
     and (to_jsonb(new) - array['status','cancelled_by','cancelled_at','cancellation_reason','row_version'])
       = (to_jsonb(old) - array['status','cancelled_by','cancelled_at','cancellation_reason','row_version']) then
    return new;
  end if;
  if old.status in ('SUBMITTED', 'SHIPPED', 'CANCELLED')
     and coalesce(current_setting('private.replenishment_post_context', true), '') <> 'on' then
    raise exception 'Submitted or posted replenishment requests are immutable';
  end if;
  return new;
end;
$$;

commit;
