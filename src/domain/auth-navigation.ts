export const PUBLIC_LOGIN_ENTRY = "/login" as const;

export function resolvePostLogoutEntry(): typeof PUBLIC_LOGIN_ENTRY {
  return PUBLIC_LOGIN_ENTRY;
}
