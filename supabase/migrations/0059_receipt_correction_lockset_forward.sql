-- Close the remaining narrow race in the 0049 receipt-correction conflict
-- path: after the source-item mutex is acquired, another item of an affected
-- request may still gain a reservation before conflict reconciliation. Abort
-- with a retryable error instead of proceeding with a partial lock set.

create or replace function private.assert_receipt_correction_lock_set(
  p_source_item_id uuid,
  p_expected_request_ids uuid[],
  p_expected_item_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  actual_request_ids uuid[];
  actual_item_ids uuid[];
begin
  select coalesce(array_agg(q.source_hr_request_id order by q.source_hr_request_id), '{}'::uuid[])
    into actual_request_ids
  from (
    select distinct r.source_hr_request_id
    from public.inventory_reservations r
    where r.item_id = p_source_item_id and r.status = 'ACTIVE'
  ) q;
  select coalesce(array_agg(q.item_id order by q.item_id), '{}'::uuid[])
    into actual_item_ids
  from (
    select distinct r.item_id
    from public.inventory_reservations r
    where r.source_hr_request_id = any(actual_request_ids) and r.status = 'ACTIVE'
    union
    select p_source_item_id
  ) q;
  if actual_request_ids is distinct from p_expected_request_ids
     or actual_item_ids is distinct from p_expected_item_ids then
    raise exception using errcode = '40001',
      message = 'Reservation lock set changed before conflict reconciliation; retry';
  end if;
end;
$$;

revoke all on function private.assert_receipt_correction_lock_set(uuid, uuid[], uuid[]) from public, anon, authenticated;

do $migration$
declare
  function_sql text;
  marker text := '  select coalesce(sum(b.on_hand_quantity), 0) + accepted_delta';
begin
  select pg_get_functiondef('public.post_purchase_receipt_correction(uuid,text,text)'::regprocedure)
    into function_sql;
  if function_sql is null or position(marker in function_sql) = 0 then
    raise exception 'post_purchase_receipt_correction definition did not contain lock-set marker';
  end if;
  function_sql := replace(
    function_sql,
    marker,
    '  perform private.assert_receipt_correction_lock_set(source_line.item_id, locked_request_ids, locked_item_ids);' || chr(10) || marker
  );
  execute function_sql;
end;
$migration$;

