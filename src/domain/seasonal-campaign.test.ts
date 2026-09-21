import { describe, expect, it, vi } from "vitest";
import { runSeasonalCampaignSetup, type SeasonalCampaignSetupInput } from "./seasonal-campaign";

const input: SeasonalCampaignSetupInput = {
  campaignNo: "SEASON-2026-AW",
  name: "2026 秋冬",
  season: "2026 秋冬",
  windowStart: "2026-09-20",
  windowEnd: "2026-09-30",
  opensAt: "2026-09-20T01:00:00.000Z",
  closesAt: "2026-09-30T10:00:00.000Z",
  employeeIds: ["employee-1"],
  itemIds: ["item-1"],
  createIdempotencyKey: "CREATE-KEY",
  createRequestFingerprint: "CREATE-FINGERPRINT",
  scopeIdempotencyKey: "SCOPE-KEY",
  scopeRequestFingerprint: "SCOPE-FINGERPRINT",
};

describe("seasonal campaign atomic setup adapter", () => {
  it("uses one RPC round trip when the atomic function is installed", async () => {
    const rpc = vi.fn(async () => ({ data: { id: "campaign-1", campaign_no: input.campaignNo }, error: null }));

    const result = await runSeasonalCampaignSetup(rpc, input);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("create_seasonal_campaign_with_scope", {
      p_campaign_no: input.campaignNo,
      p_name: input.name,
      p_season: input.season,
      p_window_start: input.windowStart,
      p_window_end: input.windowEnd,
      p_opens_at: input.opensAt,
      p_closes_at: input.closesAt,
      p_create_idempotency_key: input.createIdempotencyKey,
      p_scope_idempotency_key: input.scopeIdempotencyKey,
      p_create_request_fingerprint: input.createRequestFingerprint,
      p_scope_request_fingerprint: input.scopeRequestFingerprint,
      p_employee_ids: input.employeeIds,
      p_item_ids: input.itemIds,
    });
    expect(result).toEqual({
      campaign: { id: "campaign-1", campaign_no: input.campaignNo },
      error: null,
      failureStage: null,
      usedLegacyFallback: false,
    });
  });

  it("falls back to the original idempotent RPCs only when the atomic function is missing", async () => {
    const rpc = vi.fn(async (functionName: string) => {
      if (functionName === "create_seasonal_campaign_with_scope") {
        return { data: null, error: { code: "PGRST202", message: "Could not find the function public.create_seasonal_campaign_with_scope in the schema cache" } };
      }
      return { data: { id: "campaign-1", campaign_no: input.campaignNo }, error: null };
    });

    const result = await runSeasonalCampaignSetup(rpc, input);

    expect(rpc.mock.calls.map(([functionName]) => functionName)).toEqual([
      "create_seasonal_campaign_with_scope",
      "create_seasonal_campaign",
      "set_seasonal_campaign_scope",
    ]);
    expect(result.failureStage).toBeNull();
    expect(result.usedLegacyFallback).toBe(true);
  });

  it("skips repeated setup probes for the same database client while retaining legacy recovery", async () => {
    const calls: string[] = [];
    const rpc = vi.fn(async (functionName: string) => {
      calls.push(functionName);
      if (functionName === "create_seasonal_campaign_with_scope") {
        return { data: null, error: { code: "PGRST202", message: "Could not find the function public.create_seasonal_campaign_with_scope in the schema cache" } };
      }
      return { data: { id: "campaign-1", campaign_no: input.campaignNo }, error: null };
    });

    await runSeasonalCampaignSetup(rpc, input);
    calls.length = 0;
    const result = await runSeasonalCampaignSetup(rpc, input);

    expect(calls).toEqual(["create_seasonal_campaign", "set_seasonal_campaign_scope"]);
    expect(result.campaign?.id).toBe("campaign-1");
    expect(result.usedLegacyFallback).toBe(true);
  });

  it("does not mask authorization or business errors by attempting the legacy flow", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: "42501", message: "permission denied" } }));

    const result = await runSeasonalCampaignSetup(rpc, input);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(result.failureStage).toBe("setup");
    expect(result.usedLegacyFallback).toBe(false);
  });

  it("keeps a legacy partial campaign recoverable through only the scope RPC", async () => {
    const rpc = vi.fn(async () => ({ data: { id: "campaign-existing", campaign_no: input.campaignNo }, error: null }));

    const result = await runSeasonalCampaignSetup(rpc, { ...input, existingCampaignId: "campaign-existing" });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("set_seasonal_campaign_scope", expect.objectContaining({ p_campaign_id: "campaign-existing" }));
    expect(result.campaign?.id).toBe("campaign-existing");
    expect(result.failureStage).toBeNull();
    expect(result.usedLegacyFallback).toBe(true);
  });

  it("returns the created campaign when the legacy scope step needs retry", async () => {
    const rpc = vi.fn(async (functionName: string) => {
      if (functionName === "create_seasonal_campaign_with_scope") {
        return { data: null, error: { code: "PGRST202", message: "Could not find the function public.create_seasonal_campaign_with_scope in the schema cache" } };
      }
      if (functionName === "set_seasonal_campaign_scope") {
        return { data: null, error: { code: "40001", message: "scope rejected" } };
      }
      return { data: { id: "campaign-1", campaign_no: input.campaignNo }, error: null };
    });

    const result = await runSeasonalCampaignSetup(rpc, input);

    expect(result.campaign?.id).toBe("campaign-1");
    expect(result.failureStage).toBe("scope");
    expect(result.error?.code).toBe("40001");
  });
});
