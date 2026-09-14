-- Keep the backup allowlist deployable on a fresh Supabase project.  These
-- buckets hold retained/archive bytes and are intentionally private.
insert into storage.buckets (id, name, public, file_size_limit)
values ('uniform-artifacts', 'uniform-artifacts', false, 20000000)
on conflict (id) do update set public = false;
insert into storage.buckets (id, name, public, file_size_limit)
values ('uniform-render-temp', 'uniform-render-temp', false, 20000000)
on conflict (id) do update set public = false;
