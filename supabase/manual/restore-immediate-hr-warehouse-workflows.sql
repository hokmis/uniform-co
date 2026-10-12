-- Generated from existing migrations 0114, 0127, 0128, 0130, 0137.
-- Schema-only; no business transactions or migration ledger edits.
-- Validate in isolated staging before production. Run the entire file.
begin;

do $preflight$
declare
  required_signature text;
begin
  foreach required_signature in array array[
    'public.post_warehouse_shipment(uuid,text,text)',
    'public.create_warehouse_shipment_draft(text,uuid,text,text)',
    'public.create_stocktake_draft(text,uuid,text,jsonb,text,text)',
    'public.update_stocktake_draft(uuid,text,jsonb,boolean,text,text)',
    'public.post_stocktake(uuid,text,text)',
    'public.create_hr_request_draft(text,date,text,jsonb,jsonb,text,text)',
    'public.update_hr_request_draft(uuid,date,text,jsonb,jsonb,text,text)',
    'public.submit_hr_request(uuid,text,text)',
    'public.create_replenishment_draft(text,text,jsonb,text,text)',
    'public.update_replenishment_request_draft(uuid,text,jsonb,text,text)',
    'public.submit_replenishment_request(uuid,text,text)'
  ] loop
    if to_regprocedure(required_signature) is null then
      raise exception 'Required workflow prerequisite missing: %', required_signature;
    end if;
  end loop;
end;
$preflight$;

-- Source: supabase/migrations/0114_warehouse_post_with_lines.sql
-- Keep HR shipment line edits and posting in one server-side transaction.
-- The existing post_warehouse_shipment RPC remains the posting authority;
-- this wrapper only validates and applies the draft line payload before it
-- delegates to that authority.

create or replace function public.post_warehouse_shipment_with_lines(
  p_shipment_id uuid,
  p_lines jsonb,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.warehouse_shipments
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  posted_row public.warehouse_shipments;
  line_value jsonb;
  line_count integer;
  updated_count integer;
  line_id uuid;
  inner_idempotency_key text;
  inner_request_fingerprint text;
begin
  current_account := private.current_account_id();
  if auth.uid() is null
     or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null
     or not private.has_role('WAREHOUSE') then
    raise exception using errcode = '42501', message = 'WAREHOUSE role is required';
  end if;

  if p_shipment_id is null
     or btrim(coalesce(p_idempotency_key, '')) = ''
     or btrim(coalesce(p_request_fingerprint, '')) = ''
     or p_lines is null
     or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'Shipment post fields are invalid';
  end if;
  line_count := jsonb_array_length(p_lines);
  if line_count = 0 or line_count > 1000 or pg_column_size(p_lines) > 10000000 then
    raise exception 'Shipment line limits exceeded';
  end if;

  for line_value in select value from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(line_value) <> 'object'
       or coalesce(line_value ->> 'lineId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or coalesce(line_value ->> 'actualTransferQuantity', '') !~ '^[0-9][0-9]{0,17}$'
       or length(coalesce(line_value ->> 'shortShipReasonCode', '')) > 100 then
      raise exception 'Invalid shipment line';
    end if;
  end loop;
  if exists (
    select 1
    from (
      select (value ->> 'lineId')::uuid as line_id
      from jsonb_array_elements(p_lines)
    ) requested
    group by line_id
    having count(*) > 1
  ) then
    raise exception 'A shipment cannot contain the same line more than once';
  end if;
  if line_count <> (
    select count(*)
    from public.warehouse_shipment_lines shipment_line
    where shipment_line.shipment_id = p_shipment_id
  )
  or exists (
    select 1
    from public.warehouse_shipment_lines shipment_line
    where shipment_line.shipment_id = p_shipment_id
      and not exists (
        select 1
        from jsonb_array_elements(p_lines) payload
        where (payload ->> 'lineId')::uuid = shipment_line.id
      )
  ) then
    raise exception 'Shipment lines changed; reload the draft and retry';
  end if;

  insert into public.operation_commands (
    operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id
  ) values (
    'POST_WAREHOUSE_SHIPMENT_WITH_LINES', p_idempotency_key, p_request_fingerprint, current_account
  ) on conflict (operation_code, idempotency_key) do nothing
  returning * into command_row;

  if command_row.id is null then
    select * into command_row
    from public.operation_commands
    where operation_code = 'POST_WAREHOUSE_SHIPMENT_WITH_LINES'
      and idempotency_key = p_idempotency_key
    for update;
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED'
       and command_row.result_entity_id = p_shipment_id then
      select * into posted_row
      from public.warehouse_shipments
      where id = p_shipment_id;
      return posted_row;
    end if;
    raise exception using errcode = '40001', message = 'shipment is already in progress or failed';
  end if;

  for line_value in select value from jsonb_array_elements(p_lines) loop
    line_id := (line_value ->> 'lineId')::uuid;
    update public.warehouse_shipment_lines shipment_line
    set actual_transfer_quantity = (line_value ->> 'actualTransferQuantity')::bigint,
        short_ship_reason_code = nullif(btrim(line_value ->> 'shortShipReasonCode'), '')
    where shipment_line.id = line_id
      and shipment_line.shipment_id = p_shipment_id;
    get diagnostics updated_count = row_count;
    if updated_count <> 1 then
      raise exception 'Shipment line does not belong to the shipment';
    end if;
  end loop;

  inner_idempotency_key := concat('WITH-LINES:', p_idempotency_key);
  inner_request_fingerprint := concat('WITH-LINES:', p_request_fingerprint);
  posted_row := public.post_warehouse_shipment(
    p_shipment_id,
    inner_idempotency_key,
    inner_request_fingerprint
  );

  update public.operation_commands
  set status = 'SUCCEEDED',
      result_entity_type = 'warehouse_shipments',
      result_entity_id = p_shipment_id,
      succeeded_at = now()
  where id = command_row.id;

  return posted_row;
end;
$$;

revoke all on function public.post_warehouse_shipment_with_lines(uuid, jsonb, text, text) from public, anon;
grant execute on function public.post_warehouse_shipment_with_lines(uuid, jsonb, text, text) to authenticated;


-- Source: supabase/migrations/0127_atomic_stocktake_completion.sql
-- Complete the common stocktake path in one transaction while reusing the
-- existing snapshot, role, idempotency, reservation, and posting rules.
create or replace function public.complete_stocktake(
  p_stocktake_id uuid,
  p_stocktake_no text,
  p_warehouse_id uuid,
  p_note text,
  p_lines jsonb,
  p_create_idempotency_key text,
  p_create_request_fingerprint text,
  p_update_idempotency_key text,
  p_update_request_fingerprint text,
  p_post_idempotency_key text,
  p_post_request_fingerprint text
)
returns public.stocktakes
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  draft_row public.stocktakes;
  completed_row public.stocktakes;
begin
  current_account := private.current_account_id();
  if auth.uid() is null
     or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null
     or (not private.has_role('HR') and not private.has_role('WAREHOUSE')) then
    raise exception using errcode = '42501', message = 'HR or WAREHOUSE role is required';
  end if;

  if p_stocktake_id is null then
    draft_row := public.create_stocktake_draft(
      p_stocktake_no,
      p_warehouse_id,
      p_note,
      p_lines,
      p_create_idempotency_key,
      p_create_request_fingerprint
    );
  else
    draft_row := public.update_stocktake_draft(
      p_stocktake_id,
      p_note,
      p_lines,
      false,
      p_update_idempotency_key,
      p_update_request_fingerprint
    );
  end if;

  if draft_row.id is null then
    raise exception 'Stocktake completion did not produce a draft';
  end if;

  completed_row := public.post_stocktake(
    draft_row.id,
    p_post_idempotency_key,
    p_post_request_fingerprint
  );
  return completed_row;
end;
$$;

revoke all on function public.complete_stocktake(uuid, text, uuid, text, jsonb, text, text, text, text, text, text)
  from public, anon;
grant execute on function public.complete_stocktake(uuid, text, uuid, text, jsonb, text, text, text, text, text, text)
  to authenticated;


-- Source: supabase/migrations/0128_atomic_hr_request_submission.sql

do $migration$
begin
  if to_regprocedure(
    'public.create_hr_request_draft(text, date, text, jsonb, jsonb, text, text)'
  ) is null then
    raise exception using
      errcode = '42883',
      message = '0128 requires public.create_hr_request_draft(text, date, text, jsonb, jsonb, text, text)';
  end if;

  if to_regprocedure(
    'public.update_hr_request_draft(uuid, date, text, jsonb, jsonb, text, text)'
  ) is null then
    raise exception using
      errcode = '42883',
      message = '0128 requires public.update_hr_request_draft(uuid, date, text, jsonb, jsonb, text, text)';
  end if;

  if to_regprocedure('public.submit_hr_request(uuid, text, text)') is null then
    raise exception using
      errcode = '42883',
      message = '0128 requires public.submit_hr_request(uuid, text, text)';
  end if;
end;
$migration$;

-- PostgREST executes this wrapper in one transaction. Reuse the established
-- draft and submit RPCs so their row validation, lock ordering, reservations,
-- operation-command idempotency and audit behavior remain authoritative.
create or replace function public.submit_hr_request_with_lines(
  p_request_id uuid,
  p_request_no text,
  p_distribution_date date,
  p_note text,
  p_issue_lines jsonb,
  p_increase_lines jsonb,
  p_create_idempotency_key text,
  p_create_request_fingerprint text,
  p_update_idempotency_key text,
  p_update_request_fingerprint text,
  p_submit_idempotency_key text,
  p_submit_request_fingerprint text
)
returns public.hr_requests
language plpgsql
security definer
set search_path = pg_catalog, private
as $function$
declare
  current_account uuid;
  draft_row public.hr_requests;
  submitted_row public.hr_requests;
begin
  current_account := private.current_account_id();
  if auth.uid() is null
     or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null
     or not private.has_role('HR') then
    raise exception using errcode = '42501', message = 'HR role is required';
  end if;

  if p_request_id is null then
    draft_row := public.create_hr_request_draft(
      p_request_no,
      p_distribution_date,
      p_note,
      p_issue_lines,
      p_increase_lines,
      p_create_idempotency_key,
      p_create_request_fingerprint
    );
  else
    draft_row := public.update_hr_request_draft(
      p_request_id,
      p_distribution_date,
      p_note,
      p_issue_lines,
      p_increase_lines,
      p_update_idempotency_key,
      p_update_request_fingerprint
    );
  end if;

  if draft_row.id is null then
    raise exception 'HR request submission did not produce a draft';
  end if;

  submitted_row := public.submit_hr_request(
    draft_row.id,
    p_submit_idempotency_key,
    p_submit_request_fingerprint
  );
  return submitted_row;
end;
$function$;

revoke all on function public.submit_hr_request_with_lines(
  uuid, text, date, text, jsonb, jsonb, text, text, text, text, text, text
) from public, anon;
grant execute on function public.submit_hr_request_with_lines(
  uuid, text, date, text, jsonb, jsonb, text, text, text, text, text, text
) to authenticated;


-- Source: supabase/migrations/0130_atomic_replenishment_submission.sql

do $migration$
begin
  if to_regprocedure(
    'public.create_replenishment_draft(text, text, jsonb, text, text)'
  ) is null then
    raise exception using
      errcode = '42883',
      message = '0130 requires public.create_replenishment_draft(text, text, jsonb, text, text)';
  end if;

  if to_regprocedure(
    'public.update_replenishment_request_draft(uuid, text, jsonb, text, text)'
  ) is null then
    raise exception using
      errcode = '42883',
      message = '0130 requires public.update_replenishment_request_draft(uuid, text, jsonb, text, text)';
  end if;

  if to_regprocedure('public.submit_replenishment_request(uuid, text, text)') is null then
    raise exception using
      errcode = '42883',
      message = '0130 requires public.submit_replenishment_request(uuid, text, text)';
  end if;
end;
$migration$;

-- PostgREST runs the wrapper and its established idempotent draft/submit RPCs
-- in one transaction, preserving their authorization, validation, locks and audit.
create or replace function public.submit_replenishment_request_with_lines(
  p_request_id uuid,
  p_request_no text,
  p_note text,
  p_lines jsonb,
  p_create_idempotency_key text,
  p_create_request_fingerprint text,
  p_update_idempotency_key text,
  p_update_request_fingerprint text,
  p_submit_idempotency_key text,
  p_submit_request_fingerprint text
)
returns public.replenishment_requests
language plpgsql
security definer
set search_path = pg_catalog, private
as $function$
declare
  current_account uuid;
  draft_row public.replenishment_requests;
  submitted_row public.replenishment_requests;
begin
  current_account := private.current_account_id();
  if auth.uid() is null
     or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null
     or not private.has_role('HR') then
    raise exception using errcode = '42501', message = 'HR role is required';
  end if;

  if p_request_id is null then
    draft_row := public.create_replenishment_draft(
      p_request_no,
      p_note,
      p_lines,
      p_create_idempotency_key,
      p_create_request_fingerprint
    );
  else
    draft_row := public.update_replenishment_request_draft(
      p_request_id,
      p_note,
      p_lines,
      p_update_idempotency_key,
      p_update_request_fingerprint
    );
  end if;

  if draft_row.id is null then
    raise exception 'Replenishment submission did not produce a draft';
  end if;

  submitted_row := public.submit_replenishment_request(
    draft_row.id,
    p_submit_idempotency_key,
    p_submit_request_fingerprint
  );
  return submitted_row;
end;
$function$;

revoke all on function public.submit_replenishment_request_with_lines(
  uuid, text, text, jsonb, text, text, text, text, text, text
) from public, anon;
grant execute on function public.submit_replenishment_request_with_lines(
  uuid, text, text, jsonb, text, text, text, text, text, text
) to authenticated;


-- Source: supabase/migrations/0137_atomic_hr_warehouse_shipment_completion.sql
-- Complete a new HR shipment in one PostgREST transaction.
-- The caller reviews quantities before this RPC. Existing warehouse RPCs stay
-- authoritative for the locked stock check, reservations, ledger, balances,
-- request/shipment status, and audit events.

create or replace function public.complete_hr_warehouse_shipment_with_lines(
  p_hr_request_id uuid,
  p_expected_row_version bigint,
  p_shipment_no text,
  p_lines jsonb,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.warehouse_shipments
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  request_row public.hr_requests;
  shipment_row public.warehouse_shipments;
  line_value jsonb;
  initial_item_ids uuid[];
  current_item_ids uuid[];
  line_count integer;
  updated_count integer;
  request_item_id uuid;
  item_id_row record;
begin
  current_account := private.current_account_id();
  if auth.uid() is null
     or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null
     or not private.has_role('WAREHOUSE') then
    raise exception using errcode = '42501', message = 'WAREHOUSE role is required';
  end if;

  if p_hr_request_id is null
     or p_expected_row_version is null
     or p_expected_row_version < 0
     or btrim(coalesce(p_shipment_no, '')) = ''
     or char_length(btrim(p_shipment_no)) > 80
     or btrim(coalesce(p_idempotency_key, '')) = ''
     or char_length(p_idempotency_key) > 200
     or btrim(coalesce(p_request_fingerprint, '')) = ''
     or p_lines is null
     or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'HR shipment completion fields are invalid';
  end if;

  line_count := jsonb_array_length(p_lines);
  if line_count = 0 or line_count > 1000 or pg_column_size(p_lines) > 10000000 then
    raise exception 'Shipment line limits exceeded';
  end if;

  for line_value in select value from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(line_value) <> 'object'
       or coalesce(line_value ->> 'requestItemId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or coalesce(line_value ->> 'actualTransferQuantity', '') !~ '^[0-9][0-9]{0,17}$'
       or length(coalesce(line_value ->> 'shortShipReasonCode', '')) > 100 then
      raise exception 'Invalid HR shipment line';
    end if;
  end loop;

  if exists (
    select (value ->> 'requestItemId')::uuid
    from jsonb_array_elements(p_lines) as requested(value)
    group by (value ->> 'requestItemId')::uuid
    having count(*) > 1
  ) then
    raise exception 'A shipment cannot contain the same request line more than once';
  end if;

  -- Claim the outer command before taking inventory locks. A retry after a
  -- lost HTTP response returns the already completed shipment, never creates
  -- a second draft or posts inventory twice.
  insert into public.operation_commands (
    operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id
  ) values (
    'COMPLETE_HR_WAREHOUSE_SHIPMENT', p_idempotency_key, p_request_fingerprint, current_account
  ) on conflict (operation_code, idempotency_key) do nothing
  returning * into command_row;

  if command_row.id is null then
    select * into command_row
    from public.operation_commands
    where operation_code = 'COMPLETE_HR_WAREHOUSE_SHIPMENT'
      and idempotency_key = p_idempotency_key
    for update;
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED'
       and command_row.result_entity_type = 'warehouse_shipments' then
      select * into shipment_row
      from public.warehouse_shipments
      where id = command_row.result_entity_id
        and hr_request_id = p_hr_request_id
        and status = 'POSTED';
      if shipment_row.id is not null then return shipment_row; end if;
    end if;
    raise exception using errcode = '40001', message = 'HR shipment completion is already in progress or failed';
  end if;

  select coalesce(array_agg(requested.item_id order by requested.item_id), '{}'::uuid[])
    into initial_item_ids
  from (
    select distinct item_id
    from public.hr_request_items
    where request_id = p_hr_request_id
  ) requested;
  if cardinality(initial_item_ids) = 0 then
    raise exception 'HR request needs at least one item';
  end if;

  -- Match submit, cancel, correction, and shipment posting lock order:
  -- operation command -> sorted item mutexes -> HR request -> shipment/lines.
  insert into public.inventory_item_locks (item_id)
  select requested.item_id
  from unnest(initial_item_ids) as requested(item_id)
  order by requested.item_id
  on conflict (item_id) do nothing;

  for item_id_row in
    select requested.item_id
    from unnest(initial_item_ids) as requested(item_id)
    order by requested.item_id
  loop
    perform 1
    from public.inventory_item_locks
    where item_id = item_id_row.item_id
    for update;
  end loop;

  select coalesce(array_agg(requested.item_id order by requested.item_id), '{}'::uuid[])
    into current_item_ids
  from (
    select distinct item_id
    from public.hr_request_items
    where request_id = p_hr_request_id
  ) requested;
  if current_item_ids is distinct from initial_item_ids then
    raise exception using errcode = '40001', message = 'HR request item set changed while locking; retry';
  end if;

  if line_count <> (
    select count(*) from public.hr_request_items where request_id = p_hr_request_id
  ) or exists (
    select 1
    from public.hr_request_items request_item
    where request_item.request_id = p_hr_request_id
      and not exists (
        select 1
        from jsonb_array_elements(p_lines) requested(value)
        where (requested.value ->> 'requestItemId')::uuid = request_item.id
      )
  ) then
    raise exception 'Shipment lines changed; reload the request and retry';
  end if;

  select * into request_row
  from public.hr_requests
  where id = p_hr_request_id
  for update;
  if request_row.id is null or request_row.status <> 'SUBMITTED' then
    raise exception 'Only SUBMITTED HR requests can be shipped';
  end if;
  if request_row.row_version <> p_expected_row_version then
    raise exception using errcode = '40001', message = 'HR request changed; reload the request and retry';
  end if;

  -- The existing draft RPC owns the source snapshot and audit behavior. Since
  -- its row lock occurs only after the sorted item locks above, the global lock
  -- order is preserved. Its draft is invisible outside this transaction.
  shipment_row := public.create_warehouse_shipment_draft(
    btrim(p_shipment_no),
    p_hr_request_id,
    concat('ATOMIC-CREATE:', p_idempotency_key),
    concat('ATOMIC-CREATE:', p_request_fingerprint)
  );
  if shipment_row.id is null
     or shipment_row.status <> 'DRAFT'
     or shipment_row.source_request_row_version <> p_expected_row_version then
    raise exception 'Shipment draft could not be created from the reviewed request';
  end if;

  if line_count <> (
    select count(*) from public.warehouse_shipment_lines where shipment_id = shipment_row.id
  ) or exists (
    select 1
    from public.warehouse_shipment_lines shipment_line
    where shipment_line.shipment_id = shipment_row.id
      and not exists (
        select 1
        from jsonb_array_elements(p_lines) requested(value)
        where (requested.value ->> 'requestItemId')::uuid = shipment_line.hr_request_item_id
      )
  ) then
    raise exception 'Shipment lines changed; reload the request and retry';
  end if;

  for line_value in
    select value
    from jsonb_array_elements(p_lines)
    order by (value ->> 'requestItemId')::uuid
  loop
    request_item_id := (line_value ->> 'requestItemId')::uuid;
    update public.warehouse_shipment_lines shipment_line
    set actual_transfer_quantity = (line_value ->> 'actualTransferQuantity')::bigint,
        short_ship_reason_code = nullif(btrim(line_value ->> 'shortShipReasonCode'), '')
    where shipment_line.shipment_id = shipment_row.id
      and shipment_line.hr_request_item_id = request_item_id;
    get diagnostics updated_count = row_count;
    if updated_count <> 1 then
      raise exception 'Shipment line does not belong to the reviewed HR request';
    end if;
  end loop;

  -- The existing POST RPC revalidates quantities under item/balance locks,
  -- writes immutable ledger entries, updates both balances/reservations, and
  -- marks the HR request and shipment complete in this same transaction.
  shipment_row := public.post_warehouse_shipment(
    shipment_row.id,
    concat('ATOMIC-POST:', p_idempotency_key),
    concat('ATOMIC-POST:', p_request_fingerprint)
  );
  if shipment_row.status <> 'POSTED' then
    raise exception 'HR shipment inventory completion was not confirmed';
  end if;

  update public.operation_commands
  set status = 'SUCCEEDED',
      result_entity_type = 'warehouse_shipments',
      result_entity_id = shipment_row.id,
      succeeded_at = now()
  where id = command_row.id;

  return shipment_row;
end;
$$;

revoke all on function public.complete_hr_warehouse_shipment_with_lines(uuid, bigint, text, jsonb, text, text) from public, anon;
grant execute on function public.complete_hr_warehouse_shipment_with_lines(uuid, bigint, text, jsonb, text, text) to authenticated;

comment on function public.complete_hr_warehouse_shipment_with_lines(uuid, bigint, text, jsonb, text, text)
  is 'Atomically creates and completes a new HR warehouse shipment from reviewed line quantities.';



notify pgrst, 'reload schema';
commit;

