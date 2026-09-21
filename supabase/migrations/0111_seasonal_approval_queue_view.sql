-- Consolidate pending seasonal approval submissions with their campaign label.
-- security_invoker preserves the approval and campaign RLS policies.
create or replace view public.v_seasonal_approval_queue
with (security_invoker = true)
as
select
  submission.id as submission_id,
  submission.campaign_id,
  submission.revision,
  submission.demand_snapshot_hash,
  submission.submitted_at,
  campaign.campaign_no,
  campaign.name as campaign_name
from public.seasonal_approval_submissions submission
join public.seasonal_campaigns campaign
  on campaign.id = submission.campaign_id
where submission.status = 'PENDING';

revoke all on table public.v_seasonal_approval_queue from public, anon, authenticated;
grant select on public.v_seasonal_approval_queue to authenticated;
