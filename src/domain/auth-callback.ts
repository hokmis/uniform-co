export type AuthCallbackTransport = "implicit_fragment" | "pkce_code" | "auth_error" | "empty" | "flow_mismatch";

export type AuthCallbackState = {
  transport: AuthCallbackTransport;
  canUseImplicitClient: boolean;
};

const AUTH_ERROR_KEYS = ["error", "error_code", "error_description"] as const;
const SESSION_FRAGMENT_KEYS = ["access_token", "refresh_token", "expires_in", "token_type"] as const;
const SENSITIVE_QUERY_KEYS = [
  "access_token",
  "refresh_token",
  "expires_in",
  "expires_at",
  "token_type",
  "token_hash",
  "type",
  "code",
  "flow_id",
  ...AUTH_ERROR_KEYS,
] as const;

export function inspectAuthCallbackUrl(href: string): AuthCallbackState {
  const url = new URL(href);
  const hash = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  const hasQueryError = AUTH_ERROR_KEYS.some((key) => url.searchParams.has(key));
  const hasHashError = AUTH_ERROR_KEYS.some((key) => hash.has(key));
  const hasCode = Boolean(url.searchParams.get("code"));
  const hasFragmentSession = SESSION_FRAGMENT_KEYS.some((key) => hash.has(key));

  if (hasQueryError || hasHashError) {
    return { transport: "auth_error", canUseImplicitClient: false };
  }
  if (hasCode && hasFragmentSession) {
    return { transport: "flow_mismatch", canUseImplicitClient: false };
  }
  if (hasCode) {
    return { transport: "pkce_code", canUseImplicitClient: false };
  }
  if (hasFragmentSession) {
    return { transport: "implicit_fragment", canUseImplicitClient: true };
  }
  return { transport: "empty", canUseImplicitClient: false };
}

export function scrubAuthCallbackUrl(href: string): string {
  const url = new URL(href);
  url.hash = "";
  SENSITIVE_QUERY_KEYS.forEach((key) => url.searchParams.delete(key));
  return url.toString();
}
