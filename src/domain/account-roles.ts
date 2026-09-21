export const ACCOUNT_ROLE_CODES = [
  "SYSTEM_ADMIN",
  "HR",
  "WAREHOUSE",
  "PROCUREMENT",
  "CEO",
  "DEMAND_COORDINATOR",
] as const;

export type AccountRoleCode = (typeof ACCOUNT_ROLE_CODES)[number];

/**
 * SYSTEM_ADMIN is a capability umbrella, not just another checkbox. Keep the
 * stored role rows unchanged, but expose the effective role set consistently
 * to the workspace and account-management UI.
 */
export function effectiveAccountRoles(roleCodes: readonly string[]): AccountRoleCode[] {
  const normalized = new Set(roleCodes);
  if (normalized.has("SYSTEM_ADMIN")) return [...ACCOUNT_ROLE_CODES];
  return ACCOUNT_ROLE_CODES.filter((roleCode) => normalized.has(roleCode));
}

export function accountHasEffectiveRole(roleCodes: readonly string[], roleCode: AccountRoleCode): boolean {
  return effectiveAccountRoles(roleCodes).includes(roleCode);
}
