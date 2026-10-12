-- Apply edits made to an existing receipt / return draft and complete the
-- inventory mutation in one transaction. Existing validation, locks,
-- idempotency, ledger, and audit behavior remain in the underlying RPCs.

create or replace function public.complete_existing_purchase_receipt(
  p_receipt_id uuid,
  p_delivered_quantity bigint,
  p_accepted_quantity bigint,
  p_rejected_quantity bigint,
  p_rejection_reason text,
  p_received_on date,
  p_update_idempotency_key text,
  p_update_request_fingerprint text,
  p_post_idempotency_key text,
  p_post_request_fingerprint text
)
returns public.purchase_receipts
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  receipt_row public.purchase_receipts;
begin
  current_account := private.current_account_id();
  if auth.uid() is null
     or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null
     or not private.has_role('WAREHOUSE') then
    raise exception using errcode = '42501', message = 'WAREHOUSE role is required';
  end if;

  receipt_row := public.update_purchase_receipt_draft(
    p_receipt_id,
    p_delivered_quantity,
    p_accepted_quantity,
    p_rejected_quantity,
    p_rejection_reason,
    p_received_on,
    p_update_idempotency_key,
    p_update_request_fingerprint
  );
  if receipt_row.id is null then
    raise exception 'Receipt update did not return a record';
  end if;
  -- A retry after a successful completion replays the update command and
  -- returns the already-posted receipt without applying inventory twice.
  if receipt_row.status = 'POSTED' then
    return receipt_row;
  end if;
  if receipt_row.status <> 'DRAFT' then
    raise exception 'Receipt is not completable';
  end if;

  return public.post_purchase_receipt(
    receipt_row.id,
    p_post_idempotency_key,
    p_post_request_fingerprint
  );
end;
$$;

revoke all on function public.complete_existing_purchase_receipt(uuid, bigint, bigint, bigint, text, date, text, text, text, text)
  from public, anon;
grant execute on function public.complete_existing_purchase_receipt(uuid, bigint, bigint, bigint, text, date, text, text, text, text)
  to authenticated;

create or replace function public.complete_existing_return_note(
  p_return_note_id uuid,
  p_reason text,
  p_note text,
  p_lines jsonb,
  p_update_idempotency_key text,
  p_update_request_fingerprint text,
  p_post_idempotency_key text,
  p_post_request_fingerprint text
)
returns public.return_notes
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  return_row public.return_notes;
begin
  current_account := private.current_account_id();
  if auth.uid() is null
     or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null
     or not private.has_role('HR') then
    raise exception using errcode = '42501', message = 'HR role is required';
  end if;

  return_row := public.update_return_note_draft(
    p_return_note_id,
    p_reason,
    p_note,
    p_lines,
    p_update_idempotency_key,
    p_update_request_fingerprint
  );
  if return_row.id is null then
    raise exception 'Return update did not return a record';
  end if;
  -- Idempotent update replay returns POSTED after a response-loss retry.
  if return_row.status = 'POSTED' then
    return return_row;
  end if;
  if return_row.status <> 'DRAFT' then
    raise exception 'Return note is not completable';
  end if;

  return public.post_return_note(
    return_row.id,
    p_post_idempotency_key,
    p_post_request_fingerprint
  );
end;
$$;

revoke all on function public.complete_existing_return_note(uuid, text, text, jsonb, text, text, text, text)
  from public, anon;
grant execute on function public.complete_existing_return_note(uuid, text, text, jsonb, text, text, text, text)
  to authenticated;
