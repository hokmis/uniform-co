-- Keep the primary one-click correction path to one PostgREST round trip.
-- Each wrapper delegates validation, authorization, idempotency, inventory
-- locks, ledger changes, reconciliation, and audit to the existing RPCs.
-- The wrapper is SECURITY INVOKER so the authenticated caller remains the actor.

create or replace function public.complete_return_correction(
  p_correction_no text,
  p_original_return_line_id uuid,
  p_return_quantity_delta bigint,
  p_reason text,
  p_note text,
  p_create_idempotency_key text,
  p_create_request_fingerprint text,
  p_post_idempotency_key text,
  p_post_request_fingerprint text
)
returns public.correction_notes
language plpgsql
security invoker
set search_path = pg_catalog, private
as $$
declare
  correction_row public.correction_notes;
begin
  correction_row := public.create_return_correction_draft(
    p_correction_no, p_original_return_line_id, p_return_quantity_delta,
    p_reason, p_note, p_create_idempotency_key, p_create_request_fingerprint
  );
  if correction_row.id is null then raise exception 'Return correction creation returned no record'; end if;
  if correction_row.status = 'POSTED' then return correction_row; end if;
  if correction_row.status <> 'DRAFT' then raise exception 'Return correction is not postable'; end if;
  return public.post_return_correction(
    correction_row.id, p_post_idempotency_key, p_post_request_fingerprint
  );
end;
$$;

create or replace function public.complete_hr_issue_correction(
  p_correction_no text,
  p_original_issue_line_id uuid,
  p_issue_quantity_delta bigint,
  p_reason text,
  p_note text,
  p_create_idempotency_key text,
  p_create_request_fingerprint text,
  p_post_idempotency_key text,
  p_post_request_fingerprint text
)
returns public.correction_notes
language plpgsql
security invoker
set search_path = pg_catalog, private
as $$
declare
  correction_row public.correction_notes;
begin
  correction_row := public.create_hr_issue_correction_draft(
    p_correction_no, p_original_issue_line_id, p_issue_quantity_delta,
    p_reason, p_note, p_create_idempotency_key, p_create_request_fingerprint
  );
  if correction_row.id is null then raise exception 'HR issue correction creation returned no record'; end if;
  if correction_row.status = 'POSTED' then return correction_row; end if;
  if correction_row.status <> 'DRAFT' then raise exception 'HR issue correction is not postable'; end if;
  return public.post_hr_issue_correction(
    correction_row.id, p_post_idempotency_key, p_post_request_fingerprint
  );
end;
$$;

create or replace function public.complete_warehouse_transfer_correction(
  p_correction_no text,
  p_source_kind text,
  p_source_line_id uuid,
  p_transfer_quantity_delta bigint,
  p_reason text,
  p_note text,
  p_create_idempotency_key text,
  p_create_request_fingerprint text,
  p_post_idempotency_key text,
  p_post_request_fingerprint text
)
returns public.correction_notes
language plpgsql
security invoker
set search_path = pg_catalog, private
as $$
declare
  correction_row public.correction_notes;
begin
  correction_row := public.create_warehouse_transfer_correction_draft(
    p_correction_no, p_source_kind, p_source_line_id, p_transfer_quantity_delta,
    p_reason, p_note, p_create_idempotency_key, p_create_request_fingerprint
  );
  if correction_row.id is null then raise exception 'Transfer correction creation returned no record'; end if;
  if correction_row.status = 'POSTED' then return correction_row; end if;
  if correction_row.status <> 'DRAFT' then raise exception 'Transfer correction is not postable'; end if;
  return public.post_warehouse_transfer_correction(
    correction_row.id, p_post_idempotency_key, p_post_request_fingerprint
  );
end;
$$;

create or replace function public.complete_purchase_receipt_correction(
  p_correction_no text,
  p_original_receipt_line_id uuid,
  p_delivered_quantity_delta bigint,
  p_accepted_quantity_delta bigint,
  p_rejected_quantity_delta bigint,
  p_rejection_reason text,
  p_reason text,
  p_create_idempotency_key text,
  p_create_request_fingerprint text,
  p_post_idempotency_key text,
  p_post_request_fingerprint text
)
returns public.correction_notes
language plpgsql
security invoker
set search_path = pg_catalog, private
as $$
declare
  correction_row public.correction_notes;
begin
  correction_row := public.create_purchase_receipt_correction_draft(
    p_correction_no, p_original_receipt_line_id, p_delivered_quantity_delta,
    p_accepted_quantity_delta, p_rejected_quantity_delta, p_rejection_reason,
    p_reason, p_create_idempotency_key, p_create_request_fingerprint
  );
  if correction_row.id is null then raise exception 'Receipt correction creation returned no record'; end if;
  if correction_row.status = 'POSTED' then return correction_row; end if;
  if correction_row.status <> 'DRAFT' then raise exception 'Receipt correction is not postable'; end if;
  return public.post_purchase_receipt_correction(
    correction_row.id, p_post_idempotency_key, p_post_request_fingerprint
  );
end;
$$;

create or replace function public.complete_stocktake_correction(
  p_correction_no text,
  p_original_stocktake_line_id uuid,
  p_counted_quantity_delta bigint,
  p_reason text,
  p_note text,
  p_create_idempotency_key text,
  p_create_request_fingerprint text,
  p_post_idempotency_key text,
  p_post_request_fingerprint text
)
returns public.correction_notes
language plpgsql
security invoker
set search_path = pg_catalog, private
as $$
declare
  correction_row public.correction_notes;
begin
  correction_row := public.create_stocktake_correction_draft(
    p_correction_no, p_original_stocktake_line_id, p_counted_quantity_delta,
    p_reason, p_note, p_create_idempotency_key, p_create_request_fingerprint
  );
  if correction_row.id is null then raise exception 'Stocktake correction creation returned no record'; end if;
  if correction_row.status = 'POSTED' then return correction_row; end if;
  if correction_row.status <> 'DRAFT' then raise exception 'Stocktake correction is not postable'; end if;
  return public.post_stocktake_correction(
    correction_row.id, p_post_idempotency_key, p_post_request_fingerprint
  );
end;
$$;

revoke all on function public.complete_return_correction(text, uuid, bigint, text, text, text, text, text, text) from public, anon;
revoke all on function public.complete_hr_issue_correction(text, uuid, bigint, text, text, text, text, text, text) from public, anon;
revoke all on function public.complete_warehouse_transfer_correction(text, text, uuid, bigint, text, text, text, text, text, text) from public, anon;
revoke all on function public.complete_purchase_receipt_correction(text, uuid, bigint, bigint, bigint, text, text, text, text, text, text) from public, anon;
revoke all on function public.complete_stocktake_correction(text, uuid, bigint, text, text, text, text, text, text) from public, anon;

grant execute on function public.complete_return_correction(text, uuid, bigint, text, text, text, text, text, text) to authenticated;
grant execute on function public.complete_hr_issue_correction(text, uuid, bigint, text, text, text, text, text, text) to authenticated;
grant execute on function public.complete_warehouse_transfer_correction(text, text, uuid, bigint, text, text, text, text, text, text) to authenticated;
grant execute on function public.complete_purchase_receipt_correction(text, uuid, bigint, bigint, bigint, text, text, text, text, text, text) to authenticated;
grant execute on function public.complete_stocktake_correction(text, uuid, bigint, text, text, text, text, text, text) to authenticated;
