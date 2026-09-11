-- The security-invoker inventory history view resolves human-readable source
-- numbers through these two source-map tables.  They were intentionally
-- write-protected and had no authenticated SELECT grant, which made the view
-- fail with permission denied for otherwise authorized inventory readers.
-- Keep the grant read-only and align both tables with the view's HR/WAREHOUSE
-- visibility boundary.

alter table public.opening_posting_sources enable row level security;
drop policy if exists opening_posting_sources_inventory_history_read on public.opening_posting_sources;
create policy opening_posting_sources_inventory_history_read
  on public.opening_posting_sources
  for select to authenticated
  using (private.has_role('HR') or private.has_role('WAREHOUSE'));

drop policy if exists correction_posting_sources_inventory_history_read on public.correction_posting_sources;
create policy correction_posting_sources_inventory_history_read
  on public.correction_posting_sources
  for select to authenticated
  using (private.has_role('HR') or private.has_role('WAREHOUSE'));

grant select on public.opening_posting_sources, public.correction_posting_sources to authenticated;
