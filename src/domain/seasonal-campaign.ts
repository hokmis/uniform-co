import { attemptOptionalRpc } from "../lib/optional-rpc";

export type SeasonalCampaignRpcError = {
  code?: string | null;
  message?: string | null;
};

export type SeasonalCampaignRpcCall = (
  functionName: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: SeasonalCampaignRpcError | null }>;

export type SeasonalCampaignSetupInput = {
  campaignNo: string;
  name: string;
  season: string;
  windowStart: string;
  windowEnd: string;
  opensAt: string;
  closesAt: string;
  employeeIds: string[];
  itemIds: string[];
  createIdempotencyKey: string;
  createRequestFingerprint: string;
  scopeIdempotencyKey: string;
  scopeRequestFingerprint: string;
  existingCampaignId?: string;
};

export type SeasonalCampaignReference = {
  id: string;
  campaign_no?: string;
};

export type SeasonalCampaignSetupResult = {
  campaign: SeasonalCampaignReference | null;
  error: SeasonalCampaignRpcError | null;
  failureStage: "setup" | "create" | "scope" | null;
  usedLegacyFallback: boolean;
};

function campaignReference(value: unknown): SeasonalCampaignReference | null {
  if (typeof value !== "object" || value === null || !("id" in value)) return null;
  const row = value as { id?: unknown; campaign_no?: unknown };
  if (typeof row.id !== "string" || !row.id) return null;
  return {
    id: row.id,
    ...(typeof row.campaign_no === "string" ? { campaign_no: row.campaign_no } : {}),
  };
}

function campaignFields(input: SeasonalCampaignSetupInput) {
  return {
    p_campaign_no: input.campaignNo,
    p_name: input.name,
    p_season: input.season,
    p_window_start: input.windowStart,
    p_window_end: input.windowEnd,
    p_opens_at: input.opensAt,
    p_closes_at: input.closesAt,
  };
}

function campaignArgs(input: SeasonalCampaignSetupInput) {
  return {
    ...campaignFields(input),
    p_idempotency_key: input.createIdempotencyKey,
    p_request_fingerprint: input.createRequestFingerprint,
  };
}

function scopeArgs(input: SeasonalCampaignSetupInput, campaignId: string) {
  return {
    p_campaign_id: campaignId,
    p_employee_ids: input.employeeIds,
    p_item_ids: input.itemIds,
    p_idempotency_key: input.scopeIdempotencyKey,
    p_request_fingerprint: input.scopeRequestFingerprint,
  };
}

/**
 * Prefer the atomic setup RPC so creating a campaign and freezing its scope
 * share one database transaction and one browser round trip. Older projects
 * can still use the original idempotent RPCs until the additive migration is
 * applied; an incomplete legacy scope remains recoverable by campaign ID.
 */
export async function runSeasonalCampaignSetup(
  rpc: SeasonalCampaignRpcCall,
  input: SeasonalCampaignSetupInput,
  capabilityOwner: object = rpc as object,
): Promise<SeasonalCampaignSetupResult> {
  if (input.existingCampaignId) {
    const scopeResult = await rpc("set_seasonal_campaign_scope", scopeArgs(input, input.existingCampaignId));
    const campaign = campaignReference(scopeResult.data) ?? { id: input.existingCampaignId };
    return {
      campaign,
      error: scopeResult.error,
      failureStage: scopeResult.error || !campaignReference(scopeResult.data) ? "scope" : null,
      usedLegacyFallback: true,
    };
  }

  const setupAttempt = await attemptOptionalRpc(capabilityOwner, rpc, "create_seasonal_campaign_with_scope", {
    ...campaignFields(input),
    p_employee_ids: input.employeeIds,
    p_item_ids: input.itemIds,
    p_create_idempotency_key: input.createIdempotencyKey,
    p_create_request_fingerprint: input.createRequestFingerprint,
    p_scope_idempotency_key: input.scopeIdempotencyKey,
    p_scope_request_fingerprint: input.scopeRequestFingerprint,
  });
  if (setupAttempt.status === "called") {
    const setupCampaign = campaignReference(setupAttempt.data);
    return {
      campaign: setupCampaign,
      error: setupAttempt.error,
      failureStage: setupAttempt.error || !setupCampaign ? "setup" : null,
      usedLegacyFallback: false,
    };
  }

  const createResult = await rpc("create_seasonal_campaign", campaignArgs(input));
  const createdCampaign = campaignReference(createResult.data);
  if (createResult.error || !createdCampaign) {
    return {
      campaign: null,
      error: createResult.error,
      failureStage: "create",
      usedLegacyFallback: true,
    };
  }

  const scopeResult = await rpc("set_seasonal_campaign_scope", scopeArgs(input, createdCampaign.id));
  const scopedCampaign = campaignReference(scopeResult.data);
  return {
    campaign: scopedCampaign ?? createdCampaign,
    error: scopeResult.error,
    failureStage: scopeResult.error || !scopedCampaign ? "scope" : null,
    usedLegacyFallback: true,
  };
}
