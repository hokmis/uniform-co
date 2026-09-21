import { describe, expect, it, vi } from "vitest";
import {
  SsoError,
  completeAccountBinding,
  completeSsoLogin,
  defaultSsoDiagnosticStage,
  verifyCentralSsoTicket,
  type LocalSsoAccount,
} from "./sso";

const account: LocalSsoAccount = {
  id: "11111111-1111-4111-8111-111111111111",
  authUserId: "22222222-2222-4222-8222-222222222222",
  authEmail: "operator@auth.uniform-co.invalid",
  loginName: "operator01",
  displayName: "操作人員",
  isActive: true,
  hasRole: true,
};

describe("uniform SSO flow", () => {
  it("maps known login failures to safe diagnostic stages", () => {
    expect(defaultSsoDiagnosticStage("TARGET_SESSION_UNAVAILABLE")).toBe("target_session_create_failed");
    expect(defaultSsoDiagnosticStage("LOCAL_ACCOUNT_DISABLED")).toBe("local_account_disabled");
    expect(defaultSsoDiagnosticStage("LOCAL_ACCOUNT_UNBOUND")).toBe("local_account_unbound");
    expect(defaultSsoDiagnosticStage("LOCAL_ACCOUNT_UNAUTHORIZED")).toBe("local_account_unauthorized");
    expect(defaultSsoDiagnosticStage("INVALID_SSO_IDENTITY")).toBe("central_verify_failed");
    expect(defaultSsoDiagnosticStage("SSO_CONFIGURATION_ERROR")).toBe("sso_configuration_failed");
    expect(defaultSsoDiagnosticStage("UNKNOWN_SSO_FAILURE")).toBe("sso_callback_failed");
  });

  it("routes login tickets to central verification and then creates a target session", async () => {
    const verifyTicket = vi.fn(async (ticket: string) => {
      expect(ticket).toBe("fresh-portal-ticket");
      return { localUserId: account.id };
    });
    const findAccount = vi.fn(async () => account);
    const getTargetSessionUser = vi.fn(async () => null);
    const issueTargetSession = vi.fn(async (resolved: LocalSsoAccount) => {
      expect(resolved).toBe(account);
      return "https://uniform-co.vercel.app/";
    });

    const result = await completeSsoLogin(
      { ticket: "fresh-portal-ticket", systemCode: "un", flow: "login" },
      { verifyTicket, getTargetSessionUser, findAccount, issueTargetSession },
    );

    expect(result).toEqual({ redirectTo: "https://uniform-co.vercel.app/" });
    expect(verifyTicket).toHaveBeenCalledOnce();
    expect(findAccount).toHaveBeenCalledWith({ localUserId: account.id }, { targetAuthUserId: null });
    expect(issueTargetSession).toHaveBeenCalledWith(account, { targetAuthUserId: null });
  });

  it("starts target Session lookup in parallel with central ticket verification", async () => {
    let releaseVerification!: (identity: { localUserId: string }) => void;
    const verifyTicket = vi.fn(() => new Promise<{ localUserId: string }>((resolve) => {
      releaseVerification = resolve;
    }));
    const getTargetSessionUser = vi.fn(async () => ({ id: account.authUserId }));
    const findAccount = vi.fn(async () => account);
    const issueTargetSession = vi.fn(async () => "https://uniform-co.vercel.app/app");

    const resultPromise = completeSsoLogin(
      { ticket: "parallel-ticket", systemCode: "un", flow: "login" },
      { verifyTicket, getTargetSessionUser, findAccount, issueTargetSession },
    );

    await Promise.resolve();
    expect(verifyTicket).toHaveBeenCalledOnce();
    expect(getTargetSessionUser).toHaveBeenCalledOnce();

    releaseVerification({ localUserId: account.id });
    await expect(resultPromise).resolves.toEqual({ redirectTo: "https://uniform-co.vercel.app/app" });
  });

  it("accepts an omitted flow as login and rejects unknown flows before consuming a ticket", async () => {
    const verifyTicket = vi.fn(async () => ({ localUserId: account.id }));
    const getTargetSessionUser = vi.fn(async () => null);
    const findAccount = vi.fn(async () => account);
    const issueTargetSession = vi.fn(async () => "https://uniform-co.vercel.app/");

    await completeSsoLogin(
      { ticket: "fresh-ticket", systemCode: "un", flow: null },
      { verifyTicket, getTargetSessionUser, findAccount, issueTargetSession },
    );
    expect(verifyTicket).toHaveBeenCalledOnce();

    await expect(completeSsoLogin(
      { ticket: "do-not-consume", systemCode: "un", flow: "logout" },
      { verifyTicket, getTargetSessionUser, findAccount, issueTargetSession },
    )).rejects.toMatchObject({ code: "INVALID_SSO_FLOW" });
    expect(verifyTicket).toHaveBeenCalledOnce();
  });

  it("never sends an account-binding ticket through the login verifier", async () => {
    const callBindingApi = vi.fn(async (payload: Record<string, unknown>) => {
      expect(payload.ticket).toBe("binding-ticket");
      return { ok: true as const };
    });

    const result = await completeAccountBinding(
      { ticket: "binding-ticket", systemCode: "un", flow: "account_binding" },
      account,
      { callBindingApi },
    );

    expect(result).toEqual({ status: "bound" });
    expect(callBindingApi).toHaveBeenCalledOnce();
  });

  it("does not report binding success for an ambiguous response", async () => {
    await expect(completeAccountBinding(
      { ticket: "binding-ticket", systemCode: "un", flow: "account_binding" },
      account,
      { callBindingApi: async () => ({ ok: false }) },
    )).rejects.toBeInstanceOf(SsoError);
  });

  it("accepts an explicit pending_review mapping response", async () => {
    await expect(completeAccountBinding(
      { ticket: "binding-ticket", systemCode: "un", flow: "account_binding" },
      account,
      { callBindingApi: async () => ({ ok: false, mappingStatus: "pending_review" }) },
    )).resolves.toEqual({ status: "pending_review" });
  });

  it("posts only the fixed system code to central verification and trusts only 200 plus ok=true", async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(url.toString()).toBe("https://jyecltijflcplhzjoelh.supabase.co/functions/v1/verify-sso-ticket");
      expect(init?.method).toBe("POST");
      expect(init?.body).toBe(JSON.stringify({ ticket: "one-time-ticket", systemCode: "un" }));
      return new Response(JSON.stringify({ ok: true, localUserId: account.id }), { status: 200 });
    });

    await expect(verifyCentralSsoTicket("one-time-ticket", fetcher)).resolves.toEqual({ localUserId: account.id });

    const rejected = vi.fn(async () => new Response(JSON.stringify({ ok: false }), { status: 200 }));
    await expect(verifyCentralSsoTicket("rejected-ticket", rejected)).rejects.toMatchObject({ code: "INVALID_SSO_TICKET" });
  });
});
