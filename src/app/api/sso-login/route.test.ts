import { beforeEach, describe, expect, it, vi } from "vitest";
import { SsoError } from "../../../server/sso";

const mocks = vi.hoisted(() => ({
  getCurrentLocalSsoAccount: vi.fn(),
  getTargetSessionUser: vi.fn(),
  findLocalSsoAccount: vi.fn(),
  issueTargetSupabaseSession: vi.fn(),
  cookieGet: vi.fn(),
}));

vi.mock("../../../server/sso-adapter", () => ({
  createSsoAdapter: vi.fn(() => ({
    findLocalSsoAccount: mocks.findLocalSsoAccount,
    getTargetSessionUser: mocks.getTargetSessionUser,
    getCurrentLocalSsoAccount: mocks.getCurrentLocalSsoAccount,
    issueTargetSupabaseSession: mocks.issueTargetSupabaseSession,
  })),
  getCurrentLocalSsoAccount: mocks.getCurrentLocalSsoAccount,
  findLocalSsoAccount: mocks.findLocalSsoAccount,
  issueTargetSupabaseSession: mocks.issueTargetSupabaseSession,
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: mocks.cookieGet,
    set: vi.fn(),
    delete: vi.fn(),
  })),
}));

import { GET, POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.cookieGet.mockReturnValue(undefined);
});

describe("SSO callback diagnostics", () => {
  it("stores a login ticket in same-origin HttpOnly state before verification", async () => {
    const response = await GET(new Request(
      "https://uniform-co.vercel.app/api/sso-login?system_code=un&sso_flow=login&sso_ticket=fresh-ticket",
    ));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://uniform-co.vercel.app/login?sso_pending=1");
    expect(response.headers.get("set-cookie")).toContain("uniform_sso_login_ticket=");
    expect(response.headers.get("set-cookie")).toContain("uniform_sso_login_pending=1");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=120");
    expect(mocks.getTargetSessionUser).not.toHaveBeenCalled();
    expect(mocks.findLocalSsoAccount).not.toHaveBeenCalled();
  });

  it("cancels same-origin login state without consuming a ticket", async () => {
    const response = await GET(new Request(
      "https://uniform-co.vercel.app/api/sso-login?system_code=un&sso_flow=login&cancel=1",
    ));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://uniform-co.vercel.app/login");
    expect(response.headers.get("set-cookie")).toContain("uniform_sso_login_ticket=");
    expect(response.headers.get("set-cookie")).toContain("uniform_sso_login_pending=");
    expect(response.headers.get("set-cookie")).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    expect(mocks.getTargetSessionUser).not.toHaveBeenCalled();
    expect(mocks.findLocalSsoAccount).not.toHaveBeenCalled();
  });

  it("clears pending state and returns to the local login choice when requested", async () => {
    const response = await GET(new Request(
      "https://uniform-co.vercel.app/api/sso-login?system_code=un&sso_flow=login&cancel=1&local=1",
    ));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://uniform-co.vercel.app/login?sso_local=1");
    expect(response.headers.get("set-cookie")).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  });

  it("verifies the HttpOnly ticket only after same-origin confirmation", async () => {
    mocks.cookieGet.mockImplementation((name: string) => (
      name === "uniform_sso_login_ticket" ? { value: "pending-ticket" } : undefined
    ));
    mocks.getTargetSessionUser.mockResolvedValue({ id: "auth-user", email: "user@example.com" });
    mocks.findLocalSsoAccount.mockResolvedValue({
      id: "local-account",
      authUserId: "auth-user",
      authEmail: "user@example.com",
      displayName: "測試帳號",
      isActive: true,
      hasRole: true,
    });
    mocks.issueTargetSupabaseSession.mockResolvedValue("https://uniform-co.vercel.app/app");
    const centralFetch = vi.fn(async () => new Response(
      JSON.stringify({ ok: true, localUserId: "local-account" }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", centralFetch);

    try {
      const response = await POST(new Request(
        "https://uniform-co.vercel.app/api/sso-login?system_code=un&sso_flow=login",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirm: true }),
        },
      ));

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("https://uniform-co.vercel.app/app");
      expect(centralFetch).toHaveBeenCalledOnce();
      expect(mocks.getTargetSessionUser).toHaveBeenCalledOnce();
      expect(mocks.findLocalSsoAccount).toHaveBeenCalledOnce();
      expect(mocks.issueTargetSupabaseSession).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns a readable JSON navigation result for the browser confirmation request", async () => {
    mocks.cookieGet.mockImplementation((name: string) => (
      name === "uniform_sso_login_ticket" ? { value: "pending-ticket" } : undefined
    ));
    mocks.getTargetSessionUser.mockResolvedValue({ id: "auth-user", email: "user@example.com" });
    mocks.findLocalSsoAccount.mockResolvedValue({
      id: "local-account",
      authUserId: "auth-user",
      authEmail: "user@example.com",
      displayName: "測試帳號",
      isActive: true,
      hasRole: true,
    });
    mocks.issueTargetSupabaseSession.mockResolvedValue("https://uniform-co.vercel.app/app");
    const centralFetch = vi.fn(async () => new Response(
      JSON.stringify({ ok: true, localUserId: "local-account" }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", centralFetch);

    try {
      const response = await POST(new Request(
        "https://uniform-co.vercel.app/api/sso-login?system_code=un&sso_flow=login",
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({ confirm: true }),
        },
      ));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body).toEqual({ ok: true, redirectTo: "https://uniform-co.vercel.app/app" });
      expect(response.headers.get("cache-control")).toContain("no-store");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports a missing pending state without attempting central verification", async () => {
    const response = await POST(new Request(
      "https://uniform-co.vercel.app/api/sso-login?system_code=un&sso_flow=login",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      },
    ));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.diagnosticStage).toBe("sso_pending_state_missing");
    expect(mocks.getTargetSessionUser).not.toHaveBeenCalled();
    expect(mocks.findLocalSsoAccount).not.toHaveBeenCalled();
  });

  it("returns a safe diagnosticStage when account binding configuration fails", async () => {
    mocks.getCurrentLocalSsoAccount.mockRejectedValueOnce(
      new SsoError(
        "internal configuration detail must not be returned",
        "SSO_CONFIGURATION_ERROR",
        503,
        "supabase_admin_project_mismatch",
      ),
    );

    const response = await POST(new Request(
      "https://uniform-co.vercel.app/api/sso-login?system_code=un&sso_flow=account_binding&sso_ticket=fresh-ticket",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    ));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      ok: false,
      code: "SSO_CONFIGURATION_ERROR",
      error: "SSO 設定尚未完成，請聯絡系統管理員。",
      diagnosticStage: "supabase_admin_project_mismatch",
    });
    expect(JSON.stringify(body)).not.toContain("internal configuration detail");
  });

  it("allows only the diagnosticStage allowlist through the public response", async () => {
    mocks.getCurrentLocalSsoAccount.mockRejectedValueOnce({
      code: "SSO_CONFIGURATION_ERROR",
      status: 503,
      diagnosticStage: "secret-from-an-internal-error",
    });

    const response = await POST(new Request(
      "https://uniform-co.vercel.app/api/sso-login?system_code=un&sso_flow=account_binding&sso_ticket=fresh-ticket",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    ));
    const body = await response.json();

    expect(body.diagnosticStage).toBe("sso_configuration_failed");
    expect(JSON.stringify(body)).not.toContain("secret-from-an-internal-error");
  });

  it("maps an unknown callback exception to a safe callback stage", async () => {
    mocks.getCurrentLocalSsoAccount.mockRejectedValueOnce(new Error("internal failure must not be returned"));

    const response = await POST(new Request(
      "https://uniform-co.vercel.app/api/sso-login?system_code=un&sso_flow=account_binding&sso_ticket=fresh-ticket",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    ));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      ok: false,
      code: "SSO_ERROR",
      error: "SSO 操作未完成，請稍後重試。",
      diagnosticStage: "sso_callback_failed",
    });
    expect(JSON.stringify(body)).not.toContain("internal failure must not be returned");
  });
});
