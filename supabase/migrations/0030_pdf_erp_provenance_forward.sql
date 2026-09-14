-- Forward fixes for deployed PDF/ERP artifact requests.
-- Do not edit 0011/0012 in place: Supabase applies each migration once.

drop function if exists public.request_document_pdf(text, uuid, text, bigint, text, text, text);

create or replace function public.request_document_pdf(
  p_document_type text,
  p_document_id uuid,
  p_template_version text,
  p_source_snapshot_version bigint,
  p_source_snapshot_hash text,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_artifact_kind text
)
returns public.document_artifacts
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  family_row public.document_artifact_families;
  artifact_row public.document_artifacts;
  next_revision integer;
  document_family_id uuid;
  source_version bigint;
  source_hash text;
  source_status text;
  canonical_fingerprint text;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' or current_account is null then
    raise exception using errcode = '42501', message = 'Authenticated account is required';
  end if;
  if p_document_type not in ('HR_REQUEST', 'STOCKTAKE', 'RETURN_NOTE')
     or p_document_id is null or btrim(coalesce(p_template_version, '')) = ''
     or p_source_snapshot_version <= 0 or btrim(coalesce(p_source_snapshot_hash, '')) = ''
     or btrim(coalesce(p_idempotency_key, '')) = '' or btrim(coalesce(p_request_fingerprint, '')) = ''
     or p_artifact_kind not in ('FORMAL', 'DRAFT_WATERMARK') then
    raise exception 'PDF artifact fields are invalid';
  end if;
  if not (
    (p_document_type = 'HR_REQUEST' and private.has_role('HR') and exists (select 1 from public.hr_requests where id = p_document_id))
    or (p_document_type = 'STOCKTAKE' and (private.has_role('HR') or private.has_role('WAREHOUSE')) and exists (select 1 from public.stocktakes where id = p_document_id))
    or (p_document_type = 'RETURN_NOTE' and private.has_role('HR') and exists (select 1 from public.return_notes where id = p_document_id))
  ) then raise exception using errcode = '42501', message = 'Not authorized for this document'; end if;

  begin
    if (p_request_fingerprint::jsonb) <> jsonb_build_object(
      'documentType', p_document_type,
      'documentId', p_document_id::text,
      'artifactKind', p_artifact_kind,
      'version', p_source_snapshot_version,
      'hash', p_source_snapshot_hash
    ) then
      raise exception 'PDF fingerprint must match the request payload';
    end if;
  exception when invalid_text_representation then
    raise exception 'PDF fingerprint must be valid canonical JSON';
  end;

  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('REQUEST_DOCUMENT_PDF', p_idempotency_key, p_request_fingerprint, current_account)
  on conflict (operation_code, idempotency_key) do nothing returning * into command_row;

  -- Replay a committed command before reading mutable source state. A lost
  -- response must return the original artifact even if the source changed.
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'REQUEST_DOCUMENT_PDF' and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' then
      select a.* into artifact_row
      from public.document_artifacts a
      join public.document_artifact_families f on f.id = a.family_id
      where a.id = command_row.result_entity_id
        and f.document_type = p_document_type
        and f.document_id = p_document_id
        and f.artifact_kind = p_artifact_kind
        and a.template_version = left(btrim(p_template_version), 80);
      if artifact_row.id is null then
        raise exception using errcode = '40001', message = 'idempotency key conflicts with another PDF request';
      end if;
      return artifact_row;
    end if;
    if command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    raise exception using errcode = '40001', message = 'PDF artifact request is already in progress or failed';
  end if;

  -- Lock the source document and derive its canonical snapshot. Caller supplied
  -- snapshot fields are treated as advisory only and never become provenance.
  if p_document_type = 'HR_REQUEST' then
    select greatest(r.row_version, 1), r.status::text into source_version, source_status
    from public.hr_requests r where r.id = p_document_id for update;
    select md5((select jsonb_build_object(
      'header', to_jsonb(r),
      'lines', coalesce((select jsonb_agg(to_jsonb(l) order by l.line_no) from public.hr_issue_lines l where l.request_id = r.id), '[]'::jsonb)
    )::text from public.hr_requests r where r.id = p_document_id)) into source_hash;
  elsif p_document_type = 'STOCKTAKE' then
    select 1, s.status into source_version, source_status
    from public.stocktakes s where s.id = p_document_id for update;
    select md5((select jsonb_build_object(
      'header', to_jsonb(s),
      'lines', coalesce((select jsonb_agg(to_jsonb(l) order by l.item_id) from public.stocktake_lines l where l.stocktake_id = s.id), '[]'::jsonb)
    )::text from public.stocktakes s where s.id = p_document_id)) into source_hash;
  elsif p_document_type = 'RETURN_NOTE' then
    select 1, n.status into source_version, source_status
    from public.return_notes n where n.id = p_document_id for update;
    select md5((select jsonb_build_object(
      'header', to_jsonb(n),
      'lines', coalesce((select jsonb_agg(to_jsonb(l) order by l.line_no) from public.return_lines l where l.return_note_id = n.id), '[]'::jsonb)
    )::text from public.return_notes n where n.id = p_document_id)) into source_hash;
  end if;
  if source_hash is null then raise exception 'Document source does not exist'; end if;
  if p_artifact_kind = 'FORMAL' and source_status not in ('SHIPPED', 'POSTED', 'APPROVED', 'ORDERED', 'RECEIVED') then
    raise exception 'Formal PDF requires a completed source document';
  end if;
  canonical_fingerprint := md5(jsonb_build_object(
    'document_type', p_document_type, 'document_id', p_document_id,
    'artifact_kind', p_artifact_kind, 'template_version', left(btrim(p_template_version), 80),
    'source_snapshot_version', source_version, 'source_snapshot_hash', source_hash
  )::text);
  -- Advisory lock closes the absent-family first-insert race.
  perform pg_advisory_xact_lock(hashtextextended(p_document_type || ':' || p_document_id::text || ':' || p_artifact_kind, 0));
  select * into family_row from public.document_artifact_families
  where document_type = p_document_type and document_id = p_document_id and artifact_kind = p_artifact_kind
  for update;
  if family_row.id is null then
    insert into public.document_artifact_families (
      document_type, document_id, artifact_kind, source_snapshot_version, source_snapshot_hash
    ) values (
      p_document_type, p_document_id, p_artifact_kind, source_version, source_hash
    ) returning * into family_row;
  elsif family_row.source_snapshot_version <> source_version or family_row.source_snapshot_hash <> source_hash then
    if p_artifact_kind <> 'DRAFT_WATERMARK' or exists (select 1 from public.document_artifacts where family_id = family_row.id and status = 'PREPARING') then
      raise exception 'PDF source snapshot changed; formal artifact families are immutable';
    end if;
    update public.document_artifact_families
    set source_snapshot_version = source_version, source_snapshot_hash = source_hash
    where id = family_row.id;
    family_row.source_snapshot_version := source_version;
    family_row.source_snapshot_hash := source_hash;
  end if;
  document_family_id := family_row.id;
  if exists (select 1 from public.document_artifacts da where da.family_id = document_family_id and da.status = 'PREPARING') then
    raise exception using errcode = '40001', message = 'Another PDF revision is active';
  end if;
  select coalesce(max(da.revision), 0) + 1 into next_revision from public.document_artifacts da where da.family_id = document_family_id;
  insert into public.document_artifacts (
    family_id, revision, status, idempotency_key, request_fingerprint, template_version,
    source_snapshot_version, source_snapshot_hash, supersedes_artifact_id
  ) values (
    document_family_id, next_revision, 'PREPARING', p_idempotency_key, canonical_fingerprint,
    left(btrim(p_template_version), 80), source_version, source_hash,
    (select da.id from public.document_artifacts da where da.family_id = document_family_id and da.status = 'READY' and da.is_current limit 1)
  ) returning * into artifact_row;
  insert into public.document_render_attempts (artifact_id, attempt_no, attempt_key)
  values (artifact_row.id, 1, p_idempotency_key || ':attempt:1');
  update public.operation_commands set status = 'SUCCEEDED', result_entity_type = 'document_artifacts', result_entity_id = artifact_row.id, succeeded_at = now() where id = command_row.id;
  return artifact_row;
end;
$$;

revoke all on function public.request_document_pdf(text, uuid, text, bigint, text, text, text, text) from public, anon;
grant execute on function public.request_document_pdf(text, uuid, text, bigint, text, text, text, text) to authenticated;

-- DRAFT_WATERMARK families may advance to a new source snapshot between
-- revisions; FORMAL families remain immutable. READY artifact rows themselves
-- are still immutable by the artifact branch below.
create or replace function private.prevent_ready_document_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  if tg_table_name = 'document_artifact_families' then
    if old.document_type <> new.document_type or old.document_id <> new.document_id or old.artifact_kind <> new.artifact_kind then
      raise exception 'Document family identity is immutable';
    end if;
    if old.artifact_kind <> 'DRAFT_WATERMARK'
       and (old.source_snapshot_version <> new.source_snapshot_version or old.source_snapshot_hash <> new.source_snapshot_hash) then
      raise exception 'Formal document family snapshot is immutable';
    end if;
    if exists (select 1 from public.document_artifacts a where a.family_id = old.id and a.status = 'PREPARING')
       and (old.source_snapshot_version <> new.source_snapshot_version or old.source_snapshot_hash <> new.source_snapshot_hash) then
      raise exception 'Active document revision is immutable';
    end if;
  elsif tg_table_name = 'document_artifacts' and old.status = 'READY' then
    raise exception 'READY document artifacts are immutable';
  elsif tg_table_name = 'document_render_attempts'
    and exists (select 1 from public.document_artifacts a where a.id = old.artifact_id and a.status = 'READY') then
    raise exception 'Attempts for READY document artifacts are immutable';
  end if;
  return new;
end;
$$;

create or replace function public.request_erp_artifact(
  p_batch_id uuid,
  p_format_version text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.erp_export_artifacts
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  batch_row public.erp_export_batches;
  artifact_row public.erp_export_artifacts;
  next_revision integer;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('HR') then
    raise exception using errcode = '42501', message = 'HR role is required';
  end if;
  if p_batch_id is null or btrim(coalesce(p_format_version, '')) = '' or btrim(coalesce(p_idempotency_key, '')) = ''
     or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'ERP artifact fields are required';
  end if;
  insert into public.operation_commands (operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('REQUEST_ERP_ARTIFACT', p_idempotency_key, p_request_fingerprint, current_account)
  on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'REQUEST_ERP_ARTIFACT' and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' then
      select * into artifact_row from public.erp_export_artifacts where id = command_row.result_entity_id;
      return artifact_row;
    end if;
    raise exception using errcode = '40001', message = 'ERP artifact request is already in progress or failed';
  end if;
  select * into batch_row from public.erp_export_batches where id = p_batch_id for update;
  if batch_row.id is null or batch_row.status not in ('PREPARING', 'GENERATION_FAILED', 'IMPORT_FAILED') then
    raise exception 'Batch is not ready for an artifact revision';
  end if;
  begin
    if (p_request_fingerprint::jsonb) <> jsonb_build_object(
      'batchId', p_batch_id::text,
      'formatVersion', left(btrim(p_format_version), 80),
      'sourceSnapshotVersion', batch_row.source_snapshot_version,
      'sourceSnapshotHash', batch_row.source_snapshot_hash
    ) then
      raise exception 'ERP fingerprint must exactly match the frozen source snapshot';
    end if;
  exception when invalid_text_representation then
    raise exception 'ERP fingerprint must be valid canonical JSON';
  end;
  if batch_row.active_artifact_id is not null or exists (select 1 from public.erp_export_artifacts a where a.batch_id = p_batch_id and a.status = 'PREPARING') then
    raise exception using errcode = '40001', message = 'Another ERP artifact revision is active';
  end if;
  if batch_row.status in ('GENERATION_FAILED', 'IMPORT_FAILED') then
    update public.erp_export_batches
    set status = 'PREPARING', last_error_code = null, last_error_message = null
    where id = p_batch_id returning * into batch_row;
  end if;
  select coalesce(max(revision), 0) + 1 into next_revision from public.erp_export_artifacts where batch_id = p_batch_id;
  insert into public.erp_export_artifacts (
    batch_id, revision, status, idempotency_key, request_fingerprint,
    supersedes_artifact_id, format_version, source_snapshot_version, source_snapshot_hash
  ) values (
    p_batch_id, next_revision, 'PREPARING', p_idempotency_key, p_request_fingerprint,
    batch_row.current_artifact_id, left(btrim(p_format_version), 80), batch_row.source_snapshot_version, batch_row.source_snapshot_hash
  ) returning * into artifact_row;
  insert into public.erp_export_render_attempts (artifact_id, attempt_no, attempt_key)
  values (artifact_row.id, 1, p_idempotency_key || ':attempt:1');
  update public.erp_export_batches set active_artifact_id = artifact_row.id where id = p_batch_id;
  update public.operation_commands set status = 'SUCCEEDED', result_entity_type = 'erp_export_artifacts', result_entity_id = artifact_row.id, succeeded_at = now() where id = command_row.id;
  return artifact_row;
end;
$$;

revoke all on function public.request_erp_artifact(uuid, text, text, text) from public, anon;
grant execute on function public.request_erp_artifact(uuid, text, text, text) to authenticated;
