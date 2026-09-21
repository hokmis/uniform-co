import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const panel = fs.readFileSync(path.join(root, "src/app/SeasonalCampaignPanel.tsx"), "utf8");
const migration = fs.readFileSync(path.join(root, "supabase/migrations/0125_atomic_seasonal_campaign_setup.sql"), "utf8");

describe("seasonal campaign setup contract", () => {
  it("delegates setup through the one-round-trip adapter", () => {
    const createHandler = panel.match(/async function createCampaign\(\) \{([\s\S]*?)\n  \}\n\n  async function openCampaign/)?.[1] ?? "";

    expect(createHandler).toContain("runSeasonalCampaignSetup(");
    expect(createHandler).toContain("client.rpc(functionName, args)");
    expect(createHandler).not.toContain('client.rpc("create_seasonal_campaign"');
    expect(createHandler).not.toContain('client.rpc("set_seasonal_campaign_scope"');
    expect(panel).toContain('from "@/src/domain/seasonal-campaign"');
  });

  it("composes the existing authenticated idempotent RPCs in one definer transaction", () => {
    const signature = migration.match(/create or replace function public\.create_seasonal_campaign_with_scope\(([\s\S]*?)\)\s*returns/)?.[1] ?? "";
    const body = migration.match(/create or replace function public\.create_seasonal_campaign_with_scope\([\s\S]*?as \$function\$([\s\S]*?)\$function\$/)?.[1] ?? "";

    for (const parameter of [
      "p_campaign_no",
      "p_name",
      "p_season",
      "p_window_start",
      "p_window_end",
      "p_opens_at",
      "p_closes_at",
      "p_employee_ids",
      "p_item_ids",
      "p_create_idempotency_key",
      "p_create_request_fingerprint",
      "p_scope_idempotency_key",
      "p_scope_request_fingerprint",
    ]) {
      expect(signature).toContain(parameter);
    }

    expect(body).toContain("public.create_seasonal_campaign(");
    expect(body).toContain("public.set_seasonal_campaign_scope(");
    expect(body.indexOf("public.create_seasonal_campaign(")).toBeLessThan(body.indexOf("public.set_seasonal_campaign_scope("));
    expect(body).not.toMatch(/\b(?:insert|update|delete)\s+into?\s+public\.seasonal_campaign/);
    expect(migration).toContain("security definer");
    expect(migration).toContain("set search_path = pg_catalog, private");
    expect(migration).toContain("from public, anon");
    expect(migration).toContain("to authenticated");
    expect(migration).toContain("p_create_request_fingerprint");
    expect(migration).toContain("p_scope_request_fingerprint");
  });
});
