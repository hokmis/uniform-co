-- Extend the existing snapshot-fenced PDF state machine to every document
-- type declared by 0012. The source hash is derived from the locked header and
-- ordered immutable lines; caller-provided version/hash remain advisory.

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
  source_version bigint;
  source_hash text;
  source_status text;
  snapshot jsonb;
  canonical_fingerprint text;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' or current_account is null then
    raise exception using errcode = '42501', message = 'Authenticated account is required';
  end if;
  if p_document_type not in (
       'HR_REQUEST', 'WAREHOUSE_SHIPMENT', 'REPLENISHMENT', 'STOCKTAKE',
       'RETURN_NOTE', 'SEASONAL_APPROVAL', 'PURCHASE_ORDER', 'PURCHASE_RECEIPT'
     )
     or p_document_id is null or btrim(coalesce(p_template_version, '')) = ''
     or p_source_snapshot_version is null or p_source_snapshot_version <= 0
     or btrim(coalesce(p_source_snapshot_hash, '')) = ''
     or btrim(coalesce(p_idempotency_key, '')) = '' or btrim(coalesce(p_request_fingerprint, '')) = ''
     or p_artifact_kind not in ('FORMAL', 'DRAFT_WATERMARK') then
    raise exception 'PDF artifact fields are invalid';
  end if;
  if not (
    (p_document_type = 'HR_REQUEST' and private.has_role('HR') and exists (select 1 from public.hr_requests where id = p_document_id))
    or (p_document_type = 'WAREHOUSE_SHIPMENT' and private.has_role('WAREHOUSE') and exists (select 1 from public.warehouse_shipments where id = p_document_id))
    or (p_document_type = 'REPLENISHMENT' and private.has_role('HR') and exists (select 1 from public.replenishment_requests where id = p_document_id))
    or (p_document_type = 'STOCKTAKE' and (private.has_role('HR') or private.has_role('WAREHOUSE')) and exists (select 1 from public.stocktakes where id = p_document_id))
    or (p_document_type = 'RETURN_NOTE' and private.has_role('HR') and exists (select 1 from public.return_notes where id = p_document_id))
    or (p_document_type = 'SEASONAL_APPROVAL' and (private.has_role('HR') or private.has_role('CEO')) and exists (select 1 from public.seasonal_approvals where id = p_document_id))
    or (p_document_type = 'PURCHASE_ORDER' and (private.has_role('PROCUREMENT') or private.has_role('WAREHOUSE')) and exists (select 1 from public.purchase_orders where id = p_document_id))
    or (p_document_type = 'PURCHASE_RECEIPT' and private.has_role('WAREHOUSE') and exists (select 1 from public.purchase_receipts where id = p_document_id))
  ) then
    raise exception using errcode = '42501', message = 'Not authorized for this document';
  end if;

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

  insert into public.operation_commands(operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id)
  values ('REQUEST_DOCUMENT_PDF', p_idempotency_key, p_request_fingerprint, current_account)
  on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
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
    raise exception using errcode = '40001', message = 'PDF artifact request is already in progress or failed';
  end if;

  -- Lock and derive the complete source snapshot. Every branch deliberately
  -- uses the same jsonb shape for request and renderer verification.
  if p_document_type = 'HR_REQUEST' then
    select greatest(r.row_version, 1), r.status::text into source_version, source_status
    from public.hr_requests r where r.id = p_document_id for update;
    select jsonb_build_object('header', to_jsonb(r), 'lines', coalesce((select jsonb_agg(to_jsonb(l) order by l.line_no) from public.hr_issue_lines l where l.request_id = r.id), '[]'::jsonb)) into snapshot
    from public.hr_requests r where r.id = p_document_id;
  elsif p_document_type = 'WAREHOUSE_SHIPMENT' then
    select 1, s.status into source_version, source_status from public.warehouse_shipments s where s.id = p_document_id for update;
    select jsonb_build_object('header', to_jsonb(s), 'lines', coalesce((select jsonb_agg(to_jsonb(l) order by l.id) from public.warehouse_shipment_lines l where l.shipment_id = s.id), '[]'::jsonb)) into snapshot
    from public.warehouse_shipments s where s.id = p_document_id;
  elsif p_document_type = 'REPLENISHMENT' then
    select greatest(r.row_version, 1), r.status into source_version, source_status from public.replenishment_requests r where r.id = p_document_id for update;
    select jsonb_build_object('header', to_jsonb(r), 'lines', coalesce((select jsonb_agg(to_jsonb(l) order by l.id) from public.replenishment_request_lines l where l.request_id = r.id), '[]'::jsonb)) into snapshot
    from public.replenishment_requests r where r.id = p_document_id;
  elsif p_document_type = 'STOCKTAKE' then
    select 1, s.status into source_version, source_status from public.stocktakes s where s.id = p_document_id for update;
    select jsonb_build_object('header', to_jsonb(s), 'lines', coalesce((select jsonb_agg(to_jsonb(l) order by l.item_id) from public.stocktake_lines l where l.stocktake_id = s.id), '[]'::jsonb)) into snapshot
    from public.stocktakes s where s.id = p_document_id;
  elsif p_document_type = 'RETURN_NOTE' then
    select 1, n.status into source_version, source_status from public.return_notes n where n.id = p_document_id for update;
    select jsonb_build_object('header', to_jsonb(n), 'lines', coalesce((select jsonb_agg(to_jsonb(l) order by l.line_no) from public.return_lines l where l.return_note_id = n.id), '[]'::jsonb)) into snapshot
    from public.return_notes n where n.id = p_document_id;
  elsif p_document_type = 'SEASONAL_APPROVAL' then
    select 1, a.status into source_version, source_status from public.seasonal_approvals a where a.id = p_document_id for update;
    select jsonb_build_object('header', to_jsonb(a), 'lines', coalesce((select jsonb_agg(to_jsonb(l) order by l.item_id) from public.seasonal_approval_lines l where l.approval_id = a.id), '[]'::jsonb)) into snapshot
    from public.seasonal_approvals a where a.id = p_document_id;
  elsif p_document_type = 'PURCHASE_ORDER' then
    select 1, o.status into source_version, source_status from public.purchase_orders o where o.id = p_document_id for update;
    select jsonb_build_object('header', to_jsonb(o), 'lines', coalesce((select jsonb_agg(to_jsonb(l) order by l.line_no) from public.purchase_order_lines l where l.purchase_order_id = o.id), '[]'::jsonb)) into snapshot
    from public.purchase_orders o where o.id = p_document_id;
  elsif p_document_type = 'PURCHASE_RECEIPT' then
    select 1, r.status into source_version, source_status from public.purchase_receipts r where r.id = p_document_id for update;
    select jsonb_build_object('header', to_jsonb(r), 'lines', coalesce((select jsonb_agg(to_jsonb(l) order by l.id) from public.purchase_receipt_lines l where l.receipt_id = r.id), '[]'::jsonb)) into snapshot
    from public.purchase_receipts r where r.id = p_document_id;
  end if;
  if snapshot is null then raise exception 'Document source does not exist'; end if;
  if p_artifact_kind = 'FORMAL' and not (
    (p_document_type = 'HR_REQUEST' and source_status = 'SHIPPED')
    or (p_document_type = 'WAREHOUSE_SHIPMENT' and source_status = 'POSTED')
    or (p_document_type = 'REPLENISHMENT' and source_status = 'SHIPPED')
    or (p_document_type = 'STOCKTAKE' and source_status = 'POSTED')
    or (p_document_type = 'RETURN_NOTE' and source_status = 'POSTED')
    or (p_document_type = 'SEASONAL_APPROVAL' and source_status = 'APPROVED')
    or (p_document_type = 'PURCHASE_ORDER' and source_status in ('ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'REOPENED', 'CLOSED_SHORT'))
    or (p_document_type = 'PURCHASE_RECEIPT' and source_status = 'POSTED')
  ) then
    raise exception 'Formal PDF requires a completed source document';
  end if;
  source_hash := md5(snapshot::text);
  canonical_fingerprint := md5(jsonb_build_object(
    'document_type', p_document_type, 'document_id', p_document_id,
    'artifact_kind', p_artifact_kind, 'template_version', left(btrim(p_template_version), 80),
    'source_snapshot_version', source_version, 'source_snapshot_hash', source_hash
  )::text);
  perform pg_advisory_xact_lock(hashtextextended(p_document_type || ':' || p_document_id::text || ':' || p_artifact_kind, 0));
  select * into family_row from public.document_artifact_families
  where document_type = p_document_type and document_id = p_document_id and artifact_kind = p_artifact_kind for update;
  if family_row.id is null then
    insert into public.document_artifact_families(document_type, document_id, artifact_kind, source_snapshot_version, source_snapshot_hash)
    values (p_document_type, p_document_id, p_artifact_kind, source_version, source_hash) returning * into family_row;
  elsif family_row.source_snapshot_version <> source_version or family_row.source_snapshot_hash <> source_hash then
    if p_artifact_kind <> 'DRAFT_WATERMARK' or exists (select 1 from public.document_artifacts where family_id = family_row.id and status = 'PREPARING') then
      raise exception 'PDF source snapshot changed; formal artifact families are immutable';
    end if;
    update public.document_artifact_families set source_snapshot_version = source_version, source_snapshot_hash = source_hash where id = family_row.id;
    family_row.source_snapshot_version := source_version;
    family_row.source_snapshot_hash := source_hash;
  end if;
  if exists (select 1 from public.document_artifacts where family_id = family_row.id and status = 'PREPARING') then
    raise exception using errcode = '40001', message = 'Another PDF revision is active';
  end if;
  select coalesce(max(revision), 0) + 1 into next_revision from public.document_artifacts where family_id = family_row.id;
  insert into public.document_artifacts(family_id, revision, status, idempotency_key, request_fingerprint, template_version, source_snapshot_version, source_snapshot_hash, supersedes_artifact_id)
  values (family_row.id, next_revision, 'PREPARING', p_idempotency_key, canonical_fingerprint, left(btrim(p_template_version), 80), source_version, source_hash,
    (select a.id from public.document_artifacts a where a.family_id = family_row.id and a.status = 'READY' and a.is_current limit 1)) returning * into artifact_row;
  insert into public.document_render_attempts(artifact_id, attempt_no, attempt_key) values (artifact_row.id, 1, p_idempotency_key || ':attempt:1');
  update public.operation_commands set status = 'SUCCEEDED', result_entity_type = 'document_artifacts', result_entity_id = artifact_row.id, succeeded_at = now() where id = command_row.id;
  return artifact_row;
end;
$$;

revoke all on function public.request_document_pdf(text, uuid, text, bigint, text, text, text, text) from public, anon;
grant execute on function public.request_document_pdf(text, uuid, text, bigint, text, text, text, text) to authenticated;

create or replace function public.get_document_render_payload(p_attempt_id uuid, p_lease_token text, p_lease_generation bigint)
returns jsonb
language plpgsql security definer set search_path = pg_catalog, private
as $$
declare
  r public.document_render_attempts;
  a public.document_artifacts;
  f public.document_artifact_families;
  header jsonb;
  lines jsonb;
  snapshot jsonb;
begin
  perform private.require_document_renderer();
  select * into strict r from public.document_render_attempts where id = p_attempt_id and status = 'RENDERING' and lease_token = p_lease_token and lease_generation = p_lease_generation and lease_expires_at > transaction_timestamp();
  select * into strict a from public.document_artifacts where id = r.artifact_id and status = 'PREPARING';
  select * into strict f from public.document_artifact_families where id = a.family_id and active_artifact_id = a.id;
  if f.document_type = 'HR_REQUEST' then
    select to_jsonb(x) into header from public.hr_requests x where x.id = f.document_id;
    select coalesce(jsonb_agg(to_jsonb(x) order by x.line_no), '[]'::jsonb) into lines from public.hr_issue_lines x where x.request_id = f.document_id;
  elsif f.document_type = 'WAREHOUSE_SHIPMENT' then
    select to_jsonb(x) into header from public.warehouse_shipments x where x.id = f.document_id;
    select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]'::jsonb) into lines from public.warehouse_shipment_lines x where x.shipment_id = f.document_id;
  elsif f.document_type = 'REPLENISHMENT' then
    select to_jsonb(x) into header from public.replenishment_requests x where x.id = f.document_id;
    select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]'::jsonb) into lines from public.replenishment_request_lines x where x.request_id = f.document_id;
  elsif f.document_type = 'STOCKTAKE' then
    select to_jsonb(x) into header from public.stocktakes x where x.id = f.document_id;
    select coalesce(jsonb_agg(to_jsonb(x) order by x.item_id), '[]'::jsonb) into lines from public.stocktake_lines x where x.stocktake_id = f.document_id;
  elsif f.document_type = 'RETURN_NOTE' then
    select to_jsonb(x) into header from public.return_notes x where x.id = f.document_id;
    select coalesce(jsonb_agg(to_jsonb(x) order by x.line_no), '[]'::jsonb) into lines from public.return_lines x where x.return_note_id = f.document_id;
  elsif f.document_type = 'SEASONAL_APPROVAL' then
    select to_jsonb(x) into header from public.seasonal_approvals x where x.id = f.document_id;
    select coalesce(jsonb_agg(to_jsonb(x) order by x.item_id), '[]'::jsonb) into lines from public.seasonal_approval_lines x where x.approval_id = f.document_id;
  elsif f.document_type = 'PURCHASE_ORDER' then
    select to_jsonb(x) into header from public.purchase_orders x where x.id = f.document_id;
    select coalesce(jsonb_agg(to_jsonb(x) order by x.line_no), '[]'::jsonb) into lines from public.purchase_order_lines x where x.purchase_order_id = f.document_id;
  elsif f.document_type = 'PURCHASE_RECEIPT' then
    select to_jsonb(x) into header from public.purchase_receipts x where x.id = f.document_id;
    select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]'::jsonb) into lines from public.purchase_receipt_lines x where x.receipt_id = f.document_id;
  end if;
  snapshot := jsonb_build_object('header', header, 'lines', lines);
  if header is null or md5(snapshot::text) is distinct from a.source_snapshot_hash or md5(snapshot::text) is distinct from f.source_snapshot_hash then
    raise exception 'Document render source snapshot changed' using errcode = '40001';
  end if;
  return jsonb_build_object('schema', 'uniform-document-render-payload-v1', 'document_type', f.document_type, 'document_id', f.document_id, 'artifact_id', a.id, 'artifact_kind', f.artifact_kind, 'revision', a.revision, 'template_version', a.template_version, 'source_snapshot_version', a.source_snapshot_version, 'source_snapshot_hash', a.source_snapshot_hash, 'header', header, 'lines', lines, 'canonical_snapshot', snapshot);
end;
$$;

revoke all on function public.get_document_render_payload(uuid, text, bigint) from public, anon, authenticated;
grant execute on function public.get_document_render_payload(uuid, text, bigint) to job_document_renderer;

drop policy if exists uniform_pdf_ready_read on storage.objects;
create policy uniform_pdf_ready_read on storage.objects for select to authenticated using (
  bucket_id = 'uniform-pdf' and exists (
    select 1 from public.document_download_grants g
    join public.document_artifacts a on a.id = g.artifact_id
    join public.document_artifact_families f on f.id = a.family_id
    where g.account_id = private.current_account_id()
      and g.object_key = storage.objects.name
      and g.expires_at > transaction_timestamp()
      and a.status = 'READY'
      and a.storage_object_key = storage.objects.name
      and ((f.document_type = 'HR_REQUEST' and private.has_role('HR'))
        or (f.document_type = 'WAREHOUSE_SHIPMENT' and private.has_role('WAREHOUSE'))
        or (f.document_type = 'REPLENISHMENT' and private.has_role('HR'))
        or (f.document_type = 'STOCKTAKE' and (private.has_role('HR') or private.has_role('WAREHOUSE')))
        or (f.document_type = 'RETURN_NOTE' and private.has_role('HR'))
        or (f.document_type = 'SEASONAL_APPROVAL' and (private.has_role('HR') or private.has_role('CEO')))
        or (f.document_type = 'PURCHASE_ORDER' and (private.has_role('PROCUREMENT') or private.has_role('WAREHOUSE')))
        or (f.document_type = 'PURCHASE_RECEIPT' and private.has_role('WAREHOUSE')))
  )
);

create or replace function public.download_document(p_artifact_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, private
as $$
declare r public.document_artifacts; f public.document_artifact_families; actor_id uuid; grant_id uuid;
begin
  actor_id := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' or actor_id is null then raise exception using errcode = '42501'; end if;
  select * into r from public.document_artifacts where id = p_artifact_id;
  select * into f from public.document_artifact_families where id = r.family_id;
  if r.id is null or r.status <> 'READY' then raise exception 'document is not downloadable' using errcode = '55000'; end if;
  if not ((f.document_type = 'HR_REQUEST' and private.has_role('HR'))
    or (f.document_type = 'WAREHOUSE_SHIPMENT' and private.has_role('WAREHOUSE'))
    or (f.document_type = 'REPLENISHMENT' and private.has_role('HR'))
    or (f.document_type = 'STOCKTAKE' and (private.has_role('HR') or private.has_role('WAREHOUSE')))
    or (f.document_type = 'RETURN_NOTE' and private.has_role('HR'))
    or (f.document_type = 'SEASONAL_APPROVAL' and (private.has_role('HR') or private.has_role('CEO')))
    or (f.document_type = 'PURCHASE_ORDER' and (private.has_role('PROCUREMENT') or private.has_role('WAREHOUSE')))
    or (f.document_type = 'PURCHASE_RECEIPT' and private.has_role('WAREHOUSE'))) then raise exception using errcode = '42501'; end if;
  insert into public.document_download_grants(artifact_id, account_id, object_key, expires_at)
  values (r.id, actor_id, r.storage_object_key, transaction_timestamp() + interval '2 minutes')
  returning id into grant_id;
  perform private.append_audit_event(actor_id, 'DOCUMENT_DOWNLOAD_REQUESTED', 'document_artifacts', r.id, null, to_jsonb(r), null, null, null, jsonb_build_object('bucket', 'uniform-pdf', 'grant_id', grant_id));
  return jsonb_build_object('bucket', 'uniform-pdf', 'object_key', r.storage_object_key, 'sha256', r.payload_sha256, 'size_bytes', r.payload_size_bytes, 'revision', r.revision, 'grant_id', grant_id);
end;
$$;

revoke all on function public.download_document(uuid) from public, anon;
grant execute on function public.download_document(uuid) to authenticated;
