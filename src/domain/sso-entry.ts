export const CENTRAL_PORTAL_URL = "https://sso.hok.tw/";

export type LoginSsoPresentation = "direct" | "trusted_launch" | "missing_launch" | "local";

export type LoginSsoPresentationInput = {
  hasLoginPendingCookie: boolean;
  hasLoginTicket: boolean;
  hasPendingQuery: boolean;
  localFallback: boolean;
};

export function resolveLoginSsoPresentation(input: LoginSsoPresentationInput): LoginSsoPresentation {
  if (input.localFallback) return "local";
  const hasLaunchSignal = input.hasLoginPendingCookie || input.hasLoginTicket || input.hasPendingQuery;
  if (!hasLaunchSignal) return "direct";
  if (input.hasLoginPendingCookie && input.hasLoginTicket) return "trusted_launch";
  return "missing_launch";
}

export function accountBindingResumePayload(): {
  system_code: "un";
  sso_flow: "account_binding";
  resume: true;
} {
  return {
    system_code: "un",
    sso_flow: "account_binding",
    resume: true,
  };
}
