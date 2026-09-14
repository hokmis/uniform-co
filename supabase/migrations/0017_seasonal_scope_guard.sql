-- An OPEN seasonal campaign must have a frozen, non-empty employee and item scope.

create or replace function private.require_seasonal_campaign_scope()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  if new.status = 'OPEN' then
    if not exists (select 1 from public.seasonal_campaign_employees where campaign_id = new.id)
       or not exists (select 1 from public.seasonal_campaign_items where campaign_id = new.id) then
      raise exception 'An OPEN seasonal campaign requires at least one employee and one uniform item';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists seasonal_campaign_scope_guard on public.seasonal_campaigns;
create constraint trigger seasonal_campaign_scope_guard
after insert or update of status on public.seasonal_campaigns
deferrable initially deferred
for each row execute function private.require_seasonal_campaign_scope();

revoke all on function private.require_seasonal_campaign_scope() from public, anon, authenticated;
