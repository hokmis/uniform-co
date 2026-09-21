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
