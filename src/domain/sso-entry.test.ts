import { describe, expect, it } from "vitest";
import { accountBindingResumePayload, resolveLoginSsoPresentation } from "./sso-entry";

describe("SSO account binding resume", () => {
  it("keeps the fixed system code and binding flow in the browser resume payload", () => {
    expect(accountBindingResumePayload()).toEqual({
      system_code: "un",
      sso_flow: "account_binding",
      resume: true,
    });
  });
});

describe("login SSO presentation", () => {
  it("offers an optional Central SSO choice when the login page is opened directly", () => {
    expect(resolveLoginSsoPresentation({
      hasLoginPendingCookie: false,
      hasLoginTicket: false,
      hasPendingQuery: false,
      localFallback: false,
    })).toBe("direct");
  });

  it("keeps a trusted server-side launch context in the continue state", () => {
    expect(resolveLoginSsoPresentation({
      hasLoginPendingCookie: true,
      hasLoginTicket: true,
      hasPendingQuery: true,
      localFallback: false,
    })).toBe("trusted_launch");
  });

  it("returns malformed or expired launch signals to the login choice", () => {
    expect(resolveLoginSsoPresentation({
      hasLoginPendingCookie: true,
      hasLoginTicket: false,
      hasPendingQuery: true,
      localFallback: false,
    })).toBe("missing_launch");
  });

  it("lets an explicit local-login choice suppress the optional prompt", () => {
    expect(resolveLoginSsoPresentation({
      hasLoginPendingCookie: false,
      hasLoginTicket: false,
      hasPendingQuery: false,
      localFallback: true,
    })).toBe("local");
  });
});
