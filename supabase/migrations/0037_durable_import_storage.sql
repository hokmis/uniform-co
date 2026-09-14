-- Private Storage bucket and direct-upload boundary for durable import batches.
-- Browser clients may upload only the exact key issued to their own batch;
-- worker confirmation and parsing remain separate privileged operations.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values (
  'uniform-imports', 'uniform-imports', false, 10000000,
  array['text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']::text[]
)
on conflict (id) do update set
  name = excluded.name,
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

alter table public.import_batches
  drop constraint if exists import_batches_filename_mime_check;
-- Do not rewrite legacy rows here: import_batches is append-only/audited and
-- migration sessions have no application actor. NOT VALID protects all new
-- writes while allowing a separately authorized maintenance job to quarantine
-- any pre-existing mismatches before a later VALIDATE CONSTRAINT.
alter table public.import_batches
  add constraint import_batches_filename_mime_check
  check (
    status in ('APPLIED', 'CANCELLED')
    or (lower(original_filename) like '%.csv' and expected_mime_type = 'text/csv')
    or (lower(original_filename) like '%.xlsx' and expected_mime_type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  ) not valid;

drop policy if exists uniform_import_objects_insert on storage.objects;
create policy uniform_import_objects_insert on storage.objects
for insert to authenticated
with check (
  bucket_id = 'uniform-imports'
  and exists (
    select 1 from public.import_batches b
    where b.storage_bucket = storage.objects.bucket_id
      and b.storage_object_key = storage.objects.name
      and b.upload_started_by = private.current_account_id()
      and b.status = 'AWAITING_UPLOAD'
      and b.upload_expires_at > now()
  )
);

drop policy if exists uniform_import_objects_select on storage.objects;
create policy uniform_import_objects_select on storage.objects
for select to authenticated
using (
  bucket_id = 'uniform-imports'
  and exists (
    select 1 from public.import_batches b
    where b.storage_bucket = storage.objects.bucket_id
      and b.storage_object_key = storage.objects.name
      and (b.upload_started_by = private.current_account_id() or private.has_role('SYSTEM_ADMIN'))
  )
);

-- The worker only needs metadata read-back for this fixed import bucket. It
-- never receives authenticated browser credentials and cannot write objects.
drop policy if exists uniform_import_worker_select on storage.objects;
create policy uniform_import_worker_select on storage.objects
for select to job_import_worker
using (bucket_id = 'uniform-imports');
grant select on table storage.objects to job_import_worker;

revoke update, delete on table storage.objects from authenticated;
