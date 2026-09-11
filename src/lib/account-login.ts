export const ACCOUNT_LOGIN_PATTERN = /^[a-z0-9]{2,50}$/;

const INTERNAL_AUTH_EMAIL_DOMAIN = "auth.uniform-co.invalid";

export function normalizeAccountLogin(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return ACCOUNT_LOGIN_PATTERN.test(normalized) ? normalized : null;
}

export function authEmailForAccountLogin(loginName: string): string {
  const normalized = normalizeAccountLogin(loginName);
  if (!normalized) {
    throw new TypeError("登入帳號格式不正確");
  }
  return `${normalized}@${INTERNAL_AUTH_EMAIL_DOMAIN}`;
}

export function authEmailForLoginIdentifier(identifier: string): string | null {
  const normalized = identifier.trim().toLowerCase();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    return normalized;
  }
  const loginName = normalizeAccountLogin(normalized);
  return loginName ? authEmailForAccountLogin(loginName) : null;
}

export function accountLabelFromUser(user: {
  email?: string | null;
  user_metadata?: Record<string, unknown>;
}): string {
  const displayName = user.user_metadata?.display_name;
  if (typeof displayName === "string" && displayName.trim()) return displayName.trim();
  const loginName = user.user_metadata?.login_name;
  if (typeof loginName === "string" && loginName.trim()) return loginName.trim();
  return user.email ?? "已登入帳號";
}
