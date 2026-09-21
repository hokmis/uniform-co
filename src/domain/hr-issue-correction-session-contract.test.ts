import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const panel = readFileSync(
  join(process.cwd(), "src", "app", "HrIssueCorrectionPanel.tsx"),
  "utf8",
);

describe("HR issue correction session contract", () => {
  it("waits for the workspace identity without reloading on every token refresh", () => {
    expect(panel).toContain('useWorkspaceSession');
    expect(panel).toContain('identityLoading');
    expect(panel).toContain('retrySupabaseQueriesAfterSessionRefresh');
    expect(panel).not.toContain('sessionAccessToken');
  });
});
