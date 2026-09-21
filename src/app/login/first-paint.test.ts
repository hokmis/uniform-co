import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const loginDirectory = dirname(fileURLToPath(import.meta.url));

describe("login first-paint shell", () => {
  it("keeps a visible SSO shell while the server page is loading", () => {
    const source = readFileSync(join(loginDirectory, "../SsoLoadingShell.tsx"), "utf8");
    const loginLoading = readFileSync(join(loginDirectory, "loading.tsx"), "utf8");
    const appLoading = readFileSync(join(loginDirectory, "../app/loading.tsx"), "utf8");

    expect(source).toContain("auth-landing");
    expect(source).toContain("sso-login-dialog");
    expect(source).toContain("SSO帳號登入中");
    expect(source).toContain('aria-busy="true"');
    expect(source).toContain("sso-login-status");
    expect(loginLoading).toContain("SsoLoadingShell");
    expect(appLoading).toContain("SsoLoadingShell");
  });

  it("does not turn client response or network failures into unexpected_error", () => {
    const source = readFileSync(join(loginDirectory, "../SsoLoginPrompt.tsx"), "utf8");

    expect(source).not.toContain('"unexpected_error"');
    expect(source).toContain("sso_response_invalid");
    expect(source).toContain("sso_client_request_failed");
    expect(source).toContain("sso_redirect_invalid");
    expect(source).toContain('Accept: "application/json"');
    expect(source).toContain("response.redirected");
    expect(source).toContain("response.url");
    expect(source).not.toContain('redirect: "manual"');
  });

  it("offers an explicit optional SSO choice for direct anonymous login", () => {
    const source = readFileSync(join(loginDirectory, "../SsoLoginPrompt.tsx"), "utf8");
    const loginPage = readFileSync(join(loginDirectory, "page.tsx"), "utf8");
    const entryDomain = readFileSync(join(loginDirectory, "../../domain/sso-entry.ts"), "utf8");

    expect(source).toContain("是否使用中央 SSO 登入？");
    expect(source).toContain("前往中央 SSO 登入");
    expect(source).toContain("否，使用子系統登入");
    expect(entryDomain).toContain('CENTRAL_PORTAL_URL = "https://sso.hok.tw/"');
    expect(source).not.toContain("issue-sso-ticket");
    expect(loginPage).toContain('mode="direct"');
    expect(loginPage).toContain("resolveLoginSsoPresentation");
  });

  it("keeps a trusted launch on Continue and treats a missing state as a choice", () => {
    const source = readFileSync(join(loginDirectory, "../SsoLoginPrompt.tsx"), "utf8");

    expect(source).toContain('mode === "pending"');
    expect(source).toContain("sso_pending_state_missing");
    expect(source).toContain("繼續 SSO 登入");
    expect(source).toContain("重新從中央 Portal 開始");
  });
});
