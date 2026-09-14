-- Seasonal campaign, approval, procurement and receipt transactions.

alter table public.seasonal_approval_submissions
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by uuid references public.app_accounts(id),
  add column if not exists return_reason text;

create table public.seasonal_approval_reviews (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.seasonal_approval_submissions(id),
  revision integer not null check (revision > 0),
  decision text not null check (decision in ('APPROVE', 'RETURN')),
  reason text,
  reviewed_at timestamptz not null default now(),
  reviewed_by uuid not null references public.app_accounts(id),
  unique (submission_id, revision),
  check (decision = 'APPROVE' or btrim(coalesce(reason, '')) <> '')
);

create table public.purchase_receipt_posting_sources (
  posting_id uuid primary key references public.inventory_postings(id),
  receipt_id uuid not null unique references public.purchase_receipts(id)
);

create table public.seasonal_demand_line_changes (
  id uuid primary key default gen_random_uuid(),
  demand_line_id uuid not null references public.seasonal_demand_lines(id),
  old_quantity bigint not null check (old_quantity >= 0),
  new_quantity bigint not null check (new_quantity >= 0),
  old_note text,
  new_note text,
  changed_at timestamptz not null default now(),
  changed_by uuid not null references public.app_accounts(id)
);

create or replace function private.record_seasonal_hr_demand_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
begin
  if not private.has_role('HR') then
    raise exception using errcode = '42501', message = 'HR role is required';
  end if;
  if new.campaign_id <> old.campaign_id then
    raise exception 'Campaign cannot be changed on a demand line';
  end if;
  new.hr_modified := true;
  new.updated_by := private.current_account_id();
  new.updated_at := now();
  insert into public.seasonal_demand_line_changes (
    demand_line_id, old_quantity, new_quantity, old_note, new_note, changed_by
  ) values (
    old.id, old.quantity, new.quantity, old.hr_note, new.hr_note, private.current_account_id()
  );
  return new;
end;
$$;

create trigger seasonal_demand_line_hr_change_audit
before update on public.seasonal_demand_lines
for each row execute function private.record_seasonal_hr_demand_change();

alter table public.seasonal_approval_reviews enable row level security;
alter table public.seasonal_demand_line_changes enable row level security;
alter table public.purchase_receipt_posting_sources enable row level security;
create policy seasonal_approval_reviews_read on public.seasonal_approval_reviews
  for select to authenticated using (private.has_role('HR') or private.has_role('CEO') or private.has_role('PROCUREMENT'));
create policy seasonal_demand_line_changes_read on public.seasonal_demand_line_changes
  for select to authenticated using (private.has_role('HR') or private.has_role('CEO'));
revoke all on table public.seasonal_approval_reviews, public.seasonal_demand_line_changes,
  public.purchase_receipt_posting_sources from public, anon, authenticated;
grant select on public.seasonal_approval_reviews, public.seasonal_demand_line_changes to authenticated;

create or replace function public.create_seasonal_campaign(
  p_campaign_no text,
  p_name text,
  p_season text,
  p_window_start date,
  p_window_end date,
  p_opens_at timestamptz,
  p_closes_at timestamptz,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.seasonal_campaigns
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  campaign_row public.seasonal_campaigns;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('HR') then
    raise exception using errcode = '42501', message = 'HR role is required';
  end if;
  if btrim(coalesce(p_campaign_no, '')) = '' or btrim(coalesce(p_name, '')) = ''
     or btrim(coalesce(p_season, '')) = '' or p_window_end < p_window_start
     or p_opens_at is null or p_closes_at is null or p_closes_at <= p_opens_at then
    raise exception 'Campaign fields are invalid';
  end if;
  if btrim(coalesce(p_idempotency_key, '')) = '' or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'idempotency_key and request_fingerprint are required';
  end if;
  insert into public.operation_commands (
    operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id
  ) values (
    'CREATE_SEASONAL_CAMPAIGN', p_idempotency_key, p_request_fingerprint, current_account
  ) on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'CREATE_SEASONAL_CAMPAIGN' and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' then
      select * into campaign_row from public.seasonal_campaigns where id = command_row.result_entity_id;
      return campaign_row;
    end if;
    raise exception using errcode = '40001', message = 'campaign operation is already in progress or failed';
  end if;
  insert into public.seasonal_campaigns (
    campaign_no, name, season, status, window_start, window_end, opens_at, closes_at, created_by
  ) values (
    left(btrim(p_campaign_no), 80), left(btrim(p_name), 200), left(btrim(p_season), 80),
    'DRAFT', p_window_start, p_window_end, p_opens_at, p_closes_at, current_account
  ) returning * into campaign_row;
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'seasonal_campaigns',
      result_entity_id = campaign_row.id, succeeded_at = now()
  where id = command_row.id;
  return campaign_row;
end;
$$;

create or replace function public.set_seasonal_campaign_scope(
  p_campaign_id uuid,
  p_employee_ids uuid[],
  p_item_ids uuid[],
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.seasonal_campaigns
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  campaign_row public.seasonal_campaigns;
  affected_count integer;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('HR') then
    raise exception using errcode = '42501', message = 'HR role is required';
  end if;
  if coalesce(cardinality(p_employee_ids), 0) = 0 or coalesce(cardinality(p_item_ids), 0) = 0 then
    raise exception 'Campaign scope needs at least one employee and item';
  end if;
  if btrim(coalesce(p_idempotency_key, '')) = '' or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'idempotency_key and request_fingerprint are required';
  end if;
  insert into public.operation_commands (
    operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id
  ) values (
    'SET_SEASONAL_CAMPAIGN_SCOPE', p_idempotency_key, p_request_fingerprint, current_account
  ) on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'SET_SEASONAL_CAMPAIGN_SCOPE' and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' then
      select * into campaign_row from public.seasonal_campaigns where id = command_row.result_entity_id;
      return campaign_row;
    end if;
    raise exception using errcode = '40001', message = 'campaign scope update is already in progress or failed';
  end if;
  select * into campaign_row from public.seasonal_campaigns where id = p_campaign_id for update;
  if campaign_row.id is null or campaign_row.status <> 'DRAFT' then
    raise exception 'Only DRAFT campaigns can have their scope configured';
  end if;
  delete from public.seasonal_campaign_employees where campaign_id = p_campaign_id;
  insert into public.seasonal_campaign_employees (
    campaign_id, employee_id, employee_no_snapshot, employee_name_snapshot,
    institution_id_snapshot, department_id_snapshot
  )
  select p_campaign_id, e.id, e.employee_no, e.name, e.institution_id, e.department_id
  from public.employees e where e.id = any(p_employee_ids) and e.employment_status = 'ACTIVE';
  get diagnostics affected_count = row_count;
  if affected_count <> (select count(distinct input_value) from unnest(p_employee_ids) as input_values(input_value)) then
    raise exception 'Campaign employee scope contains missing or inactive employees';
  end if;
  delete from public.seasonal_campaign_items where campaign_id = p_campaign_id;
  insert into public.seasonal_campaign_items (
    campaign_id, item_id, item_code_snapshot, item_name_snapshot, unit_snapshot
  )
  select p_campaign_id, i.id, i.item_code, i.item_name, i.unit
  from public.uniform_items i where i.id = any(p_item_ids) and i.is_active;
  get diagnostics affected_count = row_count;
  if affected_count <> (select count(distinct input_value) from unnest(p_item_ids) as input_values(input_value)) then
    raise exception 'Campaign item scope contains missing or inactive items';
  end if;
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'seasonal_campaigns',
      result_entity_id = p_campaign_id, succeeded_at = now()
  where id = command_row.id;
  return campaign_row;
end;
$$;

create or replace function public.open_seasonal_campaign(
  p_campaign_id uuid,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.seasonal_campaigns
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  campaign_row public.seasonal_campaigns;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('HR') then
    raise exception using errcode = '42501', message = 'HR role is required';
  end if;
  if btrim(coalesce(p_idempotency_key, '')) = '' or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'idempotency_key and request_fingerprint are required';
  end if;
  insert into public.operation_commands (
    operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id
  ) values (
    'OPEN_SEASONAL_CAMPAIGN', p_idempotency_key, p_request_fingerprint, current_account
  ) on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'OPEN_SEASONAL_CAMPAIGN' and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' then
      select * into campaign_row from public.seasonal_campaigns where id = command_row.result_entity_id;
      return campaign_row;
    end if;
    raise exception using errcode = '40001', message = 'campaign operation is already in progress or failed';
  end if;
  select * into campaign_row from public.seasonal_campaigns where id = p_campaign_id for update;
  if campaign_row.id is null or campaign_row.status <> 'DRAFT'
     or current_timestamp < campaign_row.opens_at
     or current_timestamp >= campaign_row.closes_at then
    raise exception 'Only a campaign inside its configured opening window can be opened';
  end if;
  update public.seasonal_campaigns set status = 'OPEN' where id = p_campaign_id returning * into campaign_row;
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'seasonal_campaigns',
      result_entity_id = campaign_row.id, succeeded_at = now()
  where id = command_row.id;
  return campaign_row;
end;
$$;

create or replace function public.close_seasonal_campaign(
  p_campaign_id uuid,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.seasonal_campaigns
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  campaign_row public.seasonal_campaigns;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('HR') then
    raise exception using errcode = '42501', message = 'HR role is required';
  end if;
  if btrim(coalesce(p_idempotency_key, '')) = '' or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'idempotency_key and request_fingerprint are required';
  end if;
  insert into public.operation_commands (
    operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id
  ) values (
    'CLOSE_SEASONAL_CAMPAIGN', p_idempotency_key, p_request_fingerprint, current_account
  ) on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'CLOSE_SEASONAL_CAMPAIGN' and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' then
      select * into campaign_row from public.seasonal_campaigns where id = command_row.result_entity_id;
      return campaign_row;
    end if;
    raise exception using errcode = '40001', message = 'campaign close is already in progress or failed';
  end if;
  select * into campaign_row from public.seasonal_campaigns where id = p_campaign_id for update;
  if campaign_row.id is null or campaign_row.status <> 'OPEN' or current_timestamp < campaign_row.closes_at then
    raise exception 'Only an expired OPEN campaign can be closed for HR review';
  end if;
  update public.seasonal_campaigns set status = 'HR_REVIEW' where id = p_campaign_id returning * into campaign_row;
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'seasonal_campaigns',
      result_entity_id = campaign_row.id, succeeded_at = now()
  where id = command_row.id;
  return campaign_row;
end;
$$;

create or replace function public.submit_seasonal_campaign(
  p_campaign_id uuid,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.seasonal_approval_submissions
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  campaign_row public.seasonal_campaigns;
  submission_row public.seasonal_approval_submissions;
  next_revision integer;
  snapshot_hash text;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('HR') then
    raise exception using errcode = '42501', message = 'HR role is required';
  end if;
  if btrim(coalesce(p_idempotency_key, '')) = '' or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'idempotency_key and request_fingerprint are required';
  end if;
  insert into public.operation_commands (
    operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id
  ) values (
    'SUBMIT_SEASONAL_CAMPAIGN', p_idempotency_key, p_request_fingerprint, current_account
  ) on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'SUBMIT_SEASONAL_CAMPAIGN' and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' then
      select * into submission_row from public.seasonal_approval_submissions where id = command_row.result_entity_id;
      return submission_row;
    end if;
    raise exception using errcode = '40001', message = 'campaign submission is already in progress or failed';
  end if;

  select * into campaign_row from public.seasonal_campaigns where id = p_campaign_id for update;
  if campaign_row.id is null or campaign_row.status <> 'HR_REVIEW' then
    raise exception 'Campaign is not ready for HR submission';
  end if;
  if exists (select 1 from public.seasonal_approval_submissions s where s.campaign_id = p_campaign_id and s.status = 'PENDING') then
    raise exception 'Campaign already has a pending approval submission';
  end if;
  select coalesce(max(revision), 0) + 1 into next_revision
  from public.seasonal_approval_submissions where campaign_id = p_campaign_id;
  select md5(coalesce(string_agg(
    format('%s:%s:%s', d.item_id, coalesce(d.size_snapshot, ''), d.quantity::text), '|'
    order by d.item_id, coalesce(d.size_snapshot, '')
  ), '')) into snapshot_hash
  from public.seasonal_demand_lines d
  where d.campaign_id = p_campaign_id and d.quantity > 0;
  insert into public.seasonal_approval_submissions (
    campaign_id, revision, status, demand_snapshot_hash, submitted_by
  ) values (
    p_campaign_id, next_revision, 'PENDING', snapshot_hash, current_account
  ) returning * into submission_row;
  insert into public.seasonal_approval_submission_lines (
    submission_id, item_id, demand_quantity_snapshot, item_code_snapshot,
    item_name_snapshot, size_snapshot, unit_snapshot
  )
  select submission_row.id, d.item_id, sum(d.quantity),
    coalesce(max(d.item_code_snapshot), max(i.item_code)),
    coalesce(max(d.item_name_snapshot), max(i.item_name)),
    max(d.size_snapshot), coalesce(max(d.unit_snapshot), max(i.unit))
  from public.seasonal_demand_lines d
  join public.uniform_items i on i.id = d.item_id
  where d.campaign_id = p_campaign_id and d.quantity > 0
  group by d.item_id;
  update public.seasonal_campaigns set status = 'PENDING_APPROVAL' where id = p_campaign_id;
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'seasonal_approval_submissions',
      result_entity_id = submission_row.id, succeeded_at = now()
  where id = command_row.id;
  return submission_row;
end;
$$;

create or replace function public.review_seasonal_submission(
  p_submission_id uuid,
  p_submission_revision integer,
  p_demand_snapshot_hash text,
  p_decision text,
  p_reason text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.seasonal_approval_submissions
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  submission_row public.seasonal_approval_submissions;
  campaign_row public.seasonal_campaigns;
  submission_campaign_id uuid;
  approval_id uuid;
  approval_no text;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('CEO') then
    raise exception using errcode = '42501', message = 'CEO role is required';
  end if;
  if upper(coalesce(p_decision, '')) not in ('APPROVE', 'RETURN') then
    raise exception 'Decision must be APPROVE or RETURN';
  end if;
  if upper(p_decision) = 'RETURN' and btrim(coalesce(p_reason, '')) = '' then
    raise exception 'A return reason is required';
  end if;
  if btrim(coalesce(p_idempotency_key, '')) = '' or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'idempotency_key and request_fingerprint are required';
  end if;
  insert into public.operation_commands (
    operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id
  ) values (
    'REVIEW_SEASONAL_SUBMISSION', p_idempotency_key, p_request_fingerprint, current_account
  ) on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'REVIEW_SEASONAL_SUBMISSION' and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' then
      select * into submission_row from public.seasonal_approval_submissions where id = command_row.result_entity_id;
      return submission_row;
    end if;
    raise exception using errcode = '40001', message = 'review is already in progress or failed';
  end if;
  select campaign_id into submission_campaign_id
  from public.seasonal_approval_submissions where id = p_submission_id;
  select * into campaign_row from public.seasonal_campaigns where id = submission_campaign_id for update;
  select * into submission_row from public.seasonal_approval_submissions where id = p_submission_id for update;
  if submission_row.id is null or submission_row.status <> 'PENDING'
     or submission_row.revision <> p_submission_revision
     or submission_row.demand_snapshot_hash <> p_demand_snapshot_hash then
    raise exception using errcode = '40001', message = 'Submission revision or snapshot is stale; reload before review';
  end if;
  if campaign_row.id is null then
    raise exception 'Only PENDING submissions can be reviewed';
  end if;
  if campaign_row.status <> 'PENDING_APPROVAL' then
    raise exception 'Campaign is not waiting for approval';
  end if;
  insert into public.seasonal_approval_reviews (
    submission_id, revision, decision, reason, reviewed_by
  ) values (
    submission_row.id, submission_row.revision, upper(p_decision),
    nullif(btrim(p_reason), ''), current_account
  );
  if upper(p_decision) = 'RETURN' then
    update public.seasonal_approval_submissions
    set status = 'RETURNED', reviewed_at = now(), reviewed_by = current_account,
        return_reason = left(btrim(p_reason), 500)
    where id = p_submission_id returning * into submission_row;
    update public.seasonal_campaigns set status = 'HR_REVIEW' where id = campaign_row.id;
  else
    approval_no := 'APP-' || substring(gen_random_uuid()::text from 1 for 8);
    insert into public.seasonal_approvals (
      approval_no, campaign_id, submission_id, demand_snapshot_hash, approved_by
    ) values (
      approval_no, campaign_row.id, submission_row.id, submission_row.demand_snapshot_hash, current_account
    ) returning id into approval_id;
    insert into public.seasonal_approval_lines (
      approval_id, item_id, demand_quantity_snapshot, approved_quantity,
      item_code_snapshot, item_name_snapshot, size_snapshot, unit_snapshot
    )
    select approval_id, l.item_id, l.demand_quantity_snapshot, l.demand_quantity_snapshot,
      l.item_code_snapshot, l.item_name_snapshot, l.size_snapshot, l.unit_snapshot
    from public.seasonal_approval_submission_lines l
    where l.submission_id = submission_row.id;
    update public.seasonal_approval_submissions
    set status = 'APPROVED', reviewed_at = now(), reviewed_by = current_account
    where id = p_submission_id returning * into submission_row;
    update public.seasonal_campaigns set status = 'APPROVED', approved_at = now() where id = campaign_row.id;
  end if;
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'seasonal_approval_submissions',
      result_entity_id = submission_row.id, succeeded_at = now()
  where id = command_row.id;
  return submission_row;
end;
$$;

create or replace function public.set_seasonal_procurement_line(
  p_approval_line_id uuid,
  p_supplier_id uuid,
  p_final_purchase_quantity bigint,
  p_difference_reason text,
  p_note text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.seasonal_procurement_lines
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  approval_line_row public.seasonal_approval_lines;
  approval_row public.seasonal_approvals;
  supplier_item_row public.supplier_uniform_items;
  procurement_row public.seasonal_procurement_lines;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('PROCUREMENT') then
    raise exception using errcode = '42501', message = 'PROCUREMENT role is required';
  end if;
  if p_final_purchase_quantity < 0 then raise exception 'final purchase quantity cannot be negative'; end if;
  if btrim(coalesce(p_idempotency_key, '')) = '' or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'idempotency_key and request_fingerprint are required';
  end if;
  insert into public.operation_commands (
    operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id
  ) values (
    'SET_SEASONAL_PROCUREMENT_LINE', p_idempotency_key, p_request_fingerprint, current_account
  ) on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'SET_SEASONAL_PROCUREMENT_LINE' and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' then
      select * into procurement_row from public.seasonal_procurement_lines where id = command_row.result_entity_id;
      return procurement_row;
    end if;
    raise exception using errcode = '40001', message = 'procurement decision is already in progress or failed';
  end if;
  select * into approval_line_row from public.seasonal_approval_lines where id = p_approval_line_id for update;
  if approval_line_row.id is null then raise exception 'Approval line not found'; end if;
  select a.* into approval_row from public.seasonal_approvals a where a.id = approval_line_row.approval_id for update;
  if approval_row.id is null or approval_row.status <> 'APPROVED' then raise exception 'Approval is not final'; end if;
  select * into supplier_item_row from public.supplier_uniform_items si
  where si.supplier_id = p_supplier_id and si.item_id = approval_line_row.item_id and si.is_active for update;
  if supplier_item_row.supplier_id is null then raise exception 'Supplier does not supply this item'; end if;
  select * into procurement_row from public.seasonal_procurement_lines
  where approval_line_id = approval_line_row.id for update;
  if procurement_row.id is not null then
    raise exception 'The procurement decision is immutable; append a justified limit change instead';
  end if;
  if supplier_item_row.minimum_order_quantity is not null
     and p_final_purchase_quantity > 0 and p_final_purchase_quantity < supplier_item_row.minimum_order_quantity then
    raise exception 'Final purchase quantity is below the supplier MOQ';
  end if;
  if p_final_purchase_quantity <> approval_line_row.approved_quantity
     and btrim(coalesce(p_difference_reason, '')) = '' then
    raise exception 'A difference reason is required when purchase quantity differs';
  end if;
  insert into public.seasonal_procurement_lines (
    approval_line_id, item_id, supplier_id, approved_quantity_snapshot,
    minimum_order_quantity_snapshot, final_purchase_quantity, difference_reason, note, decided_by
  ) values (
    approval_line_row.id, approval_line_row.item_id, p_supplier_id, approval_line_row.approved_quantity,
    supplier_item_row.minimum_order_quantity, p_final_purchase_quantity,
    nullif(btrim(p_difference_reason), ''), nullif(btrim(p_note), ''), current_account
  )
  returning * into procurement_row;
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'seasonal_procurement_lines',
      result_entity_id = procurement_row.id, succeeded_at = now()
  where id = command_row.id;
  return procurement_row;
end;
$$;

create or replace function public.change_seasonal_purchase_limit(
  p_procurement_line_id uuid,
  p_new_purchase_limit_quantity bigint,
  p_reason text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.seasonal_procurement_line_changes
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  procurement_row public.seasonal_procurement_lines;
  change_row public.seasonal_procurement_line_changes;
  current_limit bigint;
  allocated_quantity bigint;
  next_revision integer;
  existing_po record;
  existing_po_line record;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('PROCUREMENT') then
    raise exception using errcode = '42501', message = 'PROCUREMENT role is required';
  end if;
  if p_new_purchase_limit_quantity < 0 or btrim(coalesce(p_reason, '')) = '' then
    raise exception 'A non-negative purchase limit and reason are required';
  end if;
  if btrim(coalesce(p_idempotency_key, '')) = '' or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'idempotency_key and request_fingerprint are required';
  end if;
  insert into public.operation_commands (
    operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id
  ) values (
    'CHANGE_SEASONAL_PURCHASE_LIMIT', p_idempotency_key, p_request_fingerprint, current_account
  ) on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'CHANGE_SEASONAL_PURCHASE_LIMIT' and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' then
      select * into change_row from public.seasonal_procurement_line_changes where id = command_row.result_entity_id;
      return change_row;
    end if;
    raise exception using errcode = '40001', message = 'purchase limit change is already in progress or failed';
  end if;
  select * into procurement_row from public.seasonal_procurement_lines where id = p_procurement_line_id;
  if procurement_row.id is null then raise exception 'Procurement decision not found'; end if;
  for existing_po in
    select po.id from public.purchase_orders po
    join public.purchase_order_lines pol on pol.purchase_order_id = po.id
    where pol.seasonal_procurement_line_id = p_procurement_line_id
    order by po.id for update
  loop
    null;
  end loop;
  select * into procurement_row from public.seasonal_procurement_lines where id = p_procurement_line_id for update;
  for existing_po_line in
    select pol.id from public.purchase_order_lines pol
    where pol.seasonal_procurement_line_id = p_procurement_line_id
    order by pol.id for update
  loop
    null;
  end loop;
  current_limit := coalesce((
    select c.new_purchase_limit_quantity from public.seasonal_procurement_line_changes c
    where c.procurement_line_id = p_procurement_line_id order by c.revision desc limit 1
  ), procurement_row.final_purchase_quantity);
  if p_new_purchase_limit_quantity = current_limit then raise exception 'Purchase limit is unchanged'; end if;
  select coalesce(sum(case
    when po.status = 'CANCELLED' then 0
    when po.status = 'CLOSED_SHORT' then coalesce((
      select sum(prl.accepted_quantity) from public.purchase_receipt_lines prl
      join public.purchase_receipts pr on pr.id = prl.receipt_id
      where pr.purchase_order_id = po.id and pr.status = 'POSTED'
        and prl.purchase_order_line_id = po_line.id
    ), 0)
    else po_line.ordered_quantity end), 0)
  into allocated_quantity
  from public.purchase_order_lines po_line
  join public.purchase_orders po on po.id = po_line.purchase_order_id
  where po_line.seasonal_procurement_line_id = p_procurement_line_id;
  if p_new_purchase_limit_quantity < allocated_quantity then
    raise exception 'Purchase limit cannot be lower than allocated quantity';
  end if;
  select coalesce(max(revision), 0) + 1 into next_revision
  from public.seasonal_procurement_line_changes where procurement_line_id = p_procurement_line_id;
  insert into public.seasonal_procurement_line_changes (
    procurement_line_id, revision, old_purchase_limit_quantity,
    new_purchase_limit_quantity, reason, changed_by
  ) values (
    p_procurement_line_id, next_revision, current_limit,
    p_new_purchase_limit_quantity, left(btrim(p_reason), 500), current_account
  ) returning * into change_row;
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'seasonal_procurement_line_changes',
      result_entity_id = change_row.id, succeeded_at = now()
  where id = command_row.id;
  return change_row;
end;
$$;

create or replace function public.create_purchase_order(
  p_po_no text,
  p_procurement_line_id uuid,
  p_ordered_quantity bigint,
  p_order_date date,
  p_expected_arrival_date date,
  p_currency char(3),
  p_unit_price numeric,
  p_tax_rate numeric,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.purchase_orders
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  procurement_row public.seasonal_procurement_lines;
  supplier_row public.suppliers;
  po_row public.purchase_orders;
  allocated_quantity bigint;
  current_limit bigint;
  existing_po record;
  existing_po_line record;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('PROCUREMENT') then
    raise exception using errcode = '42501', message = 'PROCUREMENT role is required';
  end if;
  if btrim(coalesce(p_po_no, '')) = '' or p_ordered_quantity <= 0
     or (p_currency is not null and btrim(p_currency) <> upper(btrim(p_currency)))
     or (p_unit_price is not null and p_unit_price < 0)
     or (p_tax_rate is not null and p_tax_rate < 0) then
    raise exception 'PO fields are invalid';
  end if;
  if btrim(coalesce(p_idempotency_key, '')) = '' or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'idempotency_key and request_fingerprint are required';
  end if;
  insert into public.operation_commands (
    operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id
  ) values (
    'CREATE_PURCHASE_ORDER', p_idempotency_key, p_request_fingerprint, current_account
  ) on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'CREATE_PURCHASE_ORDER' and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' then
      select * into po_row from public.purchase_orders where id = command_row.result_entity_id;
      return po_row;
    end if;
    raise exception using errcode = '40001', message = 'purchase order is already in progress or failed';
  end if;
  select * into procurement_row from public.seasonal_procurement_lines where id = p_procurement_line_id;
  if procurement_row.id is null then raise exception 'Procurement decision not found'; end if;
  for existing_po in
    select po.id from public.purchase_orders po
    join public.purchase_order_lines pol on pol.purchase_order_id = po.id
    where pol.seasonal_procurement_line_id = procurement_row.id
    order by po.id
    for update
  loop
    null;
  end loop;
  select * into procurement_row from public.seasonal_procurement_lines where id = p_procurement_line_id for update;
  select * into supplier_row from public.suppliers where id = procurement_row.supplier_id and is_active for update;
  if supplier_row.id is null then raise exception 'Supplier is not active'; end if;
  for existing_po_line in
    select pol.id from public.purchase_order_lines pol
    where pol.seasonal_procurement_line_id = procurement_row.id
    order by pol.id
    for update
  loop
    null;
  end loop;
  current_limit := coalesce((
    select c.new_purchase_limit_quantity from public.seasonal_procurement_line_changes c
    where c.procurement_line_id = procurement_row.id order by c.revision desc limit 1
  ), procurement_row.final_purchase_quantity);
  select coalesce(sum(case
    when po.status = 'CANCELLED' then 0
    when po.status = 'CLOSED_SHORT' then coalesce((
      select sum(prl.accepted_quantity) from public.purchase_receipt_lines prl
      join public.purchase_receipts pr on pr.id = prl.receipt_id
      where pr.purchase_order_id = po.id and pr.status = 'POSTED'
        and prl.purchase_order_line_id = po_line.id
    ), 0)
    else po_line.ordered_quantity end), 0)
  into allocated_quantity
  from public.purchase_order_lines po_line
  join public.purchase_orders po on po.id = po_line.purchase_order_id
  where po_line.seasonal_procurement_line_id = procurement_row.id;
  if allocated_quantity + p_ordered_quantity > current_limit then
    raise exception 'Purchase order allocation exceeds current purchase limit';
  end if;
  insert into public.purchase_orders (
    po_no, supplier_id, supplier_code_snapshot, supplier_name_snapshot,
    status, order_date, expected_arrival_date, currency, created_by, ordered_at, ordered_by
  ) values (
    left(btrim(p_po_no), 80), supplier_row.id, supplier_row.supplier_code, supplier_row.name,
    'ORDERED', p_order_date, p_expected_arrival_date,
    coalesce(nullif(upper(btrim(p_currency)), ''), supplier_row.default_currency),
    current_account, now(), current_account
  ) returning * into po_row;
  insert into public.purchase_order_lines (
    purchase_order_id, line_no, seasonal_procurement_line_id, item_id,
    item_code_snapshot, item_name_snapshot, size_snapshot, unit_snapshot,
    initial_ordered_quantity_snapshot, ordered_quantity, unit_price_ex_tax, tax_rate
  )
  select po_row.id, 1, procurement_row.id, a.item_id,
    a.item_code_snapshot, a.item_name_snapshot, a.size_snapshot, a.unit_snapshot,
    p_ordered_quantity, p_ordered_quantity, p_unit_price, p_tax_rate
  from public.seasonal_approval_lines a
  where a.id = procurement_row.approval_line_id;
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'purchase_orders',
      result_entity_id = po_row.id, succeeded_at = now()
  where id = command_row.id;
  return po_row;
end;
$$;

create or replace function public.create_purchase_receipt_draft(
  p_receipt_no text,
  p_purchase_order_line_id uuid,
  p_delivered_quantity bigint,
  p_accepted_quantity bigint,
  p_rejected_quantity bigint,
  p_rejection_reason text,
  p_received_on date,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.purchase_receipts
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  po_line_row public.purchase_order_lines;
  po_row public.purchase_orders;
  receipt_row public.purchase_receipts;
  related_po_line record;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('WAREHOUSE') then
    raise exception using errcode = '42501', message = 'WAREHOUSE role is required';
  end if;
  if btrim(coalesce(p_receipt_no, '')) = '' or p_delivered_quantity <= 0
     or p_accepted_quantity < 0 or p_rejected_quantity < 0
     or p_accepted_quantity + p_rejected_quantity <> p_delivered_quantity then
    raise exception 'Receipt quantities are invalid';
  end if;
  if p_rejected_quantity > 0 and btrim(coalesce(p_rejection_reason, '')) = '' then
    raise exception 'A rejection reason is required';
  end if;
  if btrim(coalesce(p_idempotency_key, '')) = '' or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'idempotency_key and request_fingerprint are required';
  end if;
  insert into public.operation_commands (
    operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id
  ) values (
    'CREATE_PURCHASE_RECEIPT_DRAFT', p_idempotency_key, p_request_fingerprint, current_account
  ) on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'CREATE_PURCHASE_RECEIPT_DRAFT' and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' then
      select * into receipt_row from public.purchase_receipts where id = command_row.result_entity_id;
      return receipt_row;
    end if;
    raise exception using errcode = '40001', message = 'receipt draft is already in progress or failed';
  end if;
  select * into po_line_row from public.purchase_order_lines where id = p_purchase_order_line_id;
  select * into po_row from public.purchase_orders where id = po_line_row.purchase_order_id for update;
  if po_row.id is null or po_row.status not in ('ORDERED', 'PARTIALLY_RECEIVED', 'REOPENED') then
    raise exception 'Purchase order is not open for receipt';
  end if;
  perform 1 from public.seasonal_procurement_lines sp
  where sp.id = (
    select pol.seasonal_procurement_line_id from public.purchase_order_lines pol where pol.id = po_line_row.id
  ) for update;
  for related_po_line in
    select pol.id from public.purchase_order_lines pol
    where pol.purchase_order_id = po_row.id order by pol.id for update
  loop
    null;
  end loop;
  select * into po_line_row from public.purchase_order_lines where id = p_purchase_order_line_id for update;
  insert into public.purchase_receipts (
    receipt_no, purchase_order_id, status, received_on, created_by
  ) values (
    left(btrim(p_receipt_no), 80), po_row.id, 'DRAFT', p_received_on, current_account
  ) returning * into receipt_row;
  insert into public.purchase_receipt_lines (
    receipt_id, purchase_order_id, purchase_order_line_id, item_id,
    delivered_quantity, accepted_quantity, rejected_quantity, rejection_reason,
    item_code_snapshot, item_name_snapshot
  ) values (
    receipt_row.id, po_row.id, po_line_row.id, po_line_row.item_id,
    p_delivered_quantity, p_accepted_quantity, p_rejected_quantity, nullif(btrim(p_rejection_reason), ''),
    po_line_row.item_code_snapshot, po_line_row.item_name_snapshot
  );
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'purchase_receipts',
      result_entity_id = receipt_row.id, succeeded_at = now()
  where id = command_row.id;
  return receipt_row;
end;
$$;

create or replace function public.post_purchase_receipt(
  p_receipt_id uuid,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns public.purchase_receipts
language plpgsql
security definer
set search_path = pg_catalog, private
as $$
declare
  current_account uuid;
  command_row public.operation_commands;
  receipt_row public.purchase_receipts;
  po_row public.purchase_orders;
  po_line_row public.purchase_order_lines;
  receipt_line_row public.purchase_receipt_lines;
  general_warehouse_id uuid;
  balance_row public.inventory_balances;
  accepted_to_date bigint;
  delivered_to_date bigint;
  remaining_to_accept bigint;
  posting_id uuid;
  related_po_line record;
  locked_item_id uuid;
begin
  current_account := private.current_account_id();
  if auth.uid() is null or coalesce(auth.jwt() ->> 'role', '') <> 'authenticated'
     or current_account is null or not private.has_role('WAREHOUSE') then
    raise exception using errcode = '42501', message = 'WAREHOUSE role is required';
  end if;
  if btrim(coalesce(p_idempotency_key, '')) = '' or btrim(coalesce(p_request_fingerprint, '')) = '' then
    raise exception 'idempotency_key and request_fingerprint are required';
  end if;
  insert into public.operation_commands (
    operation_code, idempotency_key, canonical_request_fingerprint, actor_account_id
  ) values (
    'POST_PURCHASE_RECEIPT', p_idempotency_key, p_request_fingerprint, current_account
  ) on conflict (operation_code, idempotency_key) do nothing returning * into command_row;
  if command_row.id is null then
    select * into command_row from public.operation_commands
    where operation_code = 'POST_PURCHASE_RECEIPT' and idempotency_key = p_idempotency_key for update;
    if command_row.actor_account_id <> current_account
       or command_row.canonical_request_fingerprint <> p_request_fingerprint then
      raise exception using errcode = '40001', message = 'idempotency key conflicts with another request';
    end if;
    if command_row.status = 'SUCCEEDED' then
      select * into receipt_row from public.purchase_receipts where id = command_row.result_entity_id;
      return receipt_row;
    end if;
    raise exception using errcode = '40001', message = 'receipt POST is already in progress or failed';
  end if;
  select * into receipt_row from public.purchase_receipts where id = p_receipt_id;
  if receipt_row.id is null or receipt_row.status <> 'DRAFT' then raise exception 'Only DRAFT receipts can be posted'; end if;
  select * into receipt_line_row from public.purchase_receipt_lines where receipt_id = p_receipt_id order by id limit 1;
  select * into po_line_row from public.purchase_order_lines where id = receipt_line_row.purchase_order_line_id;
  if po_line_row.id is null then raise exception 'Receipt has no valid purchase order line'; end if;
  locked_item_id := po_line_row.item_id;
  insert into public.inventory_item_locks (item_id) values (po_line_row.item_id) on conflict (item_id) do nothing;
  perform 1 from public.inventory_item_locks where item_id = po_line_row.item_id for update;
  select * into po_row from public.purchase_orders where id = receipt_row.purchase_order_id for update;
  if po_row.status not in ('ORDERED', 'PARTIALLY_RECEIVED', 'REOPENED') then
    raise exception 'Purchase order is closed for receipt';
  end if;
  perform 1 from public.seasonal_procurement_lines sp
  where sp.id = (
    select pol.seasonal_procurement_line_id
    from public.purchase_order_lines pol
    join public.purchase_receipt_lines rpl on rpl.purchase_order_line_id = pol.id
    where rpl.receipt_id = p_receipt_id
    limit 1
  ) for update;
  for related_po_line in
    select pol.id from public.purchase_order_lines pol
    where pol.purchase_order_id = po_row.id order by pol.id for update
  loop
    null;
  end loop;
  select * into receipt_row from public.purchase_receipts where id = p_receipt_id for update;
  if receipt_row.status <> 'DRAFT' then raise exception using errcode = '40001', message = 'Receipt changed while locking; retry'; end if;
  select * into receipt_line_row from public.purchase_receipt_lines where receipt_id = p_receipt_id order by id limit 1 for update;
  select * into po_line_row from public.purchase_order_lines where id = receipt_line_row.purchase_order_line_id for update;
  if po_line_row.item_id <> locked_item_id then
    raise exception using errcode = '40001', message = 'Receipt item changed while locking; retry';
  end if;
  select coalesce(sum(prl.accepted_quantity), 0) into accepted_to_date
  from public.purchase_receipt_lines prl
  join public.purchase_receipts pr on pr.id = prl.receipt_id
  where pr.purchase_order_id = po_row.id and pr.status = 'POSTED'
    and prl.purchase_order_line_id = po_line_row.id;
  select coalesce(sum(prl.delivered_quantity), 0) into delivered_to_date
  from public.purchase_receipt_lines prl
  join public.purchase_receipts pr on pr.id = prl.receipt_id
  where pr.purchase_order_id = po_row.id and pr.status = 'POSTED'
    and prl.purchase_order_line_id = po_line_row.id;
  remaining_to_accept := po_line_row.ordered_quantity - accepted_to_date;
  if receipt_line_row.accepted_quantity > remaining_to_accept
     or receipt_line_row.delivered_quantity > po_line_row.ordered_quantity - delivered_to_date then
    raise exception 'Receipt quantity exceeds the ordered quantity';
  end if;
  select id into general_warehouse_id from public.warehouses where purpose = 'GENERAL' and is_active;
  if general_warehouse_id is null then raise exception 'An active GENERAL warehouse is required'; end if;
  insert into public.inventory_balances (warehouse_id, item_id)
  values (general_warehouse_id, po_line_row.item_id)
  on conflict (warehouse_id, item_id) do nothing;
  select * into balance_row from public.inventory_balances
  where warehouse_id = general_warehouse_id and item_id = po_line_row.item_id for update;
  insert into public.inventory_postings (
    idempotency_key, posting_kind, source_entity_id, posted_by
  ) values (p_idempotency_key, 'RECEIPT', p_receipt_id, current_account)
  returning id into posting_id;
  insert into public.purchase_receipt_posting_sources (posting_id, receipt_id)
  values (posting_id, p_receipt_id);
  if receipt_line_row.accepted_quantity > 0 then
    insert into public.inventory_ledger_entries (
      posting_id, line_no, warehouse_id, item_id, movement_kind, quantity_delta, occurred_on
    ) values (
      posting_id, 1, general_warehouse_id, po_line_row.item_id,
      'RECEIPT_IN', receipt_line_row.accepted_quantity, receipt_row.received_on
    );
    update public.inventory_balances
    set on_hand_quantity = on_hand_quantity + receipt_line_row.accepted_quantity,
        version = version + 1, last_posting_id = posting_id, updated_at = now()
    where warehouse_id = general_warehouse_id and item_id = po_line_row.item_id;
  end if;
  update public.purchase_receipts
  set status = 'POSTED', posted_at = now(), posted_by = current_account
  where id = p_receipt_id returning * into receipt_row;
  select coalesce(sum(prl.accepted_quantity), 0) into accepted_to_date
  from public.purchase_receipt_lines prl
  join public.purchase_receipts pr on pr.id = prl.receipt_id
  where pr.purchase_order_id = po_row.id and pr.status = 'POSTED'
    and prl.purchase_order_line_id = po_line_row.id;
  if accepted_to_date >= po_line_row.ordered_quantity then
    update public.purchase_orders set status = 'RECEIVED' where id = po_row.id;
  else
    update public.purchase_orders set status = 'PARTIALLY_RECEIVED' where id = po_row.id;
  end if;
  update public.operation_commands
  set status = 'SUCCEEDED', result_entity_type = 'purchase_receipts',
      result_entity_id = p_receipt_id, succeeded_at = now()
  where id = command_row.id;
  return receipt_row;
end;
$$;

revoke all on function public.create_seasonal_campaign(text, text, text, date, date, timestamptz, timestamptz, text, text) from public, anon;
revoke all on function public.set_seasonal_campaign_scope(uuid, uuid[], uuid[], text, text) from public, anon;
revoke all on function public.open_seasonal_campaign(uuid, text, text) from public, anon;
revoke all on function public.close_seasonal_campaign(uuid, text, text) from public, anon;
revoke all on function public.submit_seasonal_campaign(uuid, text, text) from public, anon;
revoke all on function public.review_seasonal_submission(uuid, integer, text, text, text, text, text) from public, anon;
revoke all on function public.set_seasonal_procurement_line(uuid, uuid, bigint, text, text, text, text) from public, anon;
revoke all on function public.change_seasonal_purchase_limit(uuid, bigint, text, text, text) from public, anon;
revoke all on function public.create_purchase_order(text, uuid, bigint, date, date, char, numeric, numeric, text, text) from public, anon;
revoke all on function public.create_purchase_receipt_draft(text, uuid, bigint, bigint, bigint, text, date, text, text) from public, anon;
revoke all on function public.post_purchase_receipt(uuid, text, text) from public, anon;
grant execute on function public.create_seasonal_campaign(text, text, text, date, date, timestamptz, timestamptz, text, text) to authenticated;
grant execute on function public.set_seasonal_campaign_scope(uuid, uuid[], uuid[], text, text) to authenticated;
grant execute on function public.open_seasonal_campaign(uuid, text, text) to authenticated;
grant execute on function public.close_seasonal_campaign(uuid, text, text) to authenticated;
grant execute on function public.submit_seasonal_campaign(uuid, text, text) to authenticated;
grant execute on function public.review_seasonal_submission(uuid, integer, text, text, text, text, text) to authenticated;
grant execute on function public.set_seasonal_procurement_line(uuid, uuid, bigint, text, text, text, text) to authenticated;
grant execute on function public.change_seasonal_purchase_limit(uuid, bigint, text, text, text) to authenticated;
grant execute on function public.create_purchase_order(text, uuid, bigint, date, date, char, numeric, numeric, text, text) to authenticated;
grant execute on function public.create_purchase_receipt_draft(text, uuid, bigint, bigint, bigint, text, date, text, text) to authenticated;
grant execute on function public.post_purchase_receipt(uuid, text, text) to authenticated;
