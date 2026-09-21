import { renderToStaticMarkup } from "react-dom/server";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import HrRequestWorkbench from "./HrRequestWorkbench";
import { WorkspaceSessionProvider } from "./workspace-session";

describe("HR request readiness presentation", () => {
  it("shows one actionable readiness state while preserving the data retry", () => {
    const client = createClient("https://uniform-test.supabase.co", "test-anon-key");
    const identity = { userId: null, accountId: null, roles: [], loading: false, error: null };
    const markup = renderToStaticMarkup(
      <WorkspaceSessionProvider client={client} session={null} user={null} identity={identity}>
        <HrRequestWorkbench />
      </WorkspaceSessionProvider>,
    );

    expect(markup).toContain("等待主檔資料");
    expect(markup).toContain("讀取中…");
    expect(markup).toMatch(/<button class="secondary-button" type="button">讀取中…<\/button>/);
    expect(markup).not.toContain("載入正式資料…");
    expect(markup).not.toContain("Supabase 資料");
  });
});
