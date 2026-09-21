begin;

-- Keep the single-request setup compatible with the existing audited,
-- idempotent operations. A missing prerequisite means this migration must not
-- install a wrapper with a different underlying contract.
do $migration$
begin
  if to_regprocedure(
    'public.create_seasonal_campaign(text,text,text,date,date,timestamptz,timestamptz,text,text)'
  ) is null then
    raise exception using
      errcode = '42883',
      message = '0125 requires public.create_seasonal_campaign(text,text,text,date,date,timestamptz,timestamptz,text,text)';
  end if;

  if to_regprocedure(
    'public.set_seasonal_campaign_scope(uuid,uuid[],uuid[],text,text)'
  ) is null then
    raise exception using
      errcode = '42883',
      message = '0125 requires public.set_seasonal_campaign_scope(uuid,uuid[],uuid[],text,text)';
  end if;
end;
$migration$;

-- PostgREST invokes this function in one transaction. If campaign creation or
-- scope validation fails, both existing RPCs roll back together; successful
-- calls preserve their independent operation-command idempotency records.
create or replace function public.create_seasonal_campaign_with_scope(
  p_campaign_no text,
  p_name text,
  p_season text,
  p_window_start date,
  p_window_end date,
  p_opens_at timestamptz,
  p_closes_at timestamptz,
  p_employee_ids uuid[],
  p_item_ids uuid[],
  p_create_idempotency_key text,
  p_create_request_fingerprint text,
  p_scope_idempotency_key text,
  p_scope_request_fingerprint text
)
returns public.seasonal_campaigns
language plpgsql
security definer
set search_path = pg_catalog, private
as $function$
declare
  campaign_row public.seasonal_campaigns;
begin
  campaign_row := public.create_seasonal_campaign(
    p_campaign_no,
    p_name,
    p_season,
    p_window_start,
    p_window_end,
    p_opens_at,
    p_closes_at,
    p_create_idempotency_key,
    p_create_request_fingerprint
  );

  campaign_row := public.set_seasonal_campaign_scope(
    campaign_row.id,
    p_employee_ids,
    p_item_ids,
    p_scope_idempotency_key,
    p_scope_request_fingerprint
  );

  return campaign_row;
end;
$function$;

revoke all on function public.create_seasonal_campaign_with_scope(
  text,text,text,date,date,timestamptz,timestamptz,uuid[],uuid[],text,text,text,text
) from public, anon;
grant execute on function public.create_seasonal_campaign_with_scope(
  text,text,text,date,date,timestamptz,timestamptz,uuid[],uuid[],text,text,text,text
) to authenticated;

commit;
