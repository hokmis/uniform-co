-- Download grants are written only by SECURITY DEFINER download RPCs.  Keep
-- RLS enabled for browser reads, but do not FORCE RLS on the table owner: the
-- audited RPCs must be able to insert a short-lived grant while direct table
-- DML remains revoked from all browser roles.
alter table public.document_download_grants no force row level security;
alter table public.erp_download_grants no force row level security;
