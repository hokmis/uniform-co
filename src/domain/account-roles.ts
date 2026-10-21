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

export const WORKSPACE_IDS = [
  "overview",
  "accounts",
  "hr",
  "warehouse",
  "procurement",
  "seasonal",
  "reports",
] as const;

export type AppWorkspaceId = (typeof WORKSPACE_IDS)[number];

export const WORKSPACE_LABELS: Record<AppWorkspaceId, string> = {
  overview: "總覽",
  accounts: "帳號管理",
  hr: "人資需求",
  warehouse: "倉庫作業",
  procurement: "採購與入庫",
  seasonal: "換季活動",
  reports: "報表",
};

export const ROLE_DEFAULT_WORKSPACES: Record<AccountRoleCode, readonly AppWorkspaceId[]> = {
  SYSTEM_ADMIN: ["overview", "accounts", "hr", "warehouse", "procurement", "seasonal", "reports"],
  HR: ["overview", "hr", "reports"],
  WAREHOUSE: ["overview", "warehouse", "reports"],
  PROCUREMENT: ["overview", "procurement", "seasonal", "reports"],
  CEO: ["overview", "procurement", "seasonal", "reports"],
  DEMAND_COORDINATOR: ["seasonal", "hr"],
};

export function resolveAllowedWorkspaces(roleCodes: readonly string[]): AppWorkspaceId[] {
  const effective = effectiveAccountRoles(roleCodes);
  if (effective.length === 0) return [];
  if (effective.includes("SYSTEM_ADMIN")) {
    return [...WORKSPACE_IDS];
  }
  const allowedSet = new Set<AppWorkspaceId>();
  for (const role of effective) {
    const list = ROLE_DEFAULT_WORKSPACES[role] ?? [];
    for (const ws of list) {
      allowedSet.add(ws);
    }
  }
  return WORKSPACE_IDS.filter((id) => allowedSet.has(id));
}

export type WorkspacePermissionDetail = {
  workspaceId: AppWorkspaceId;
  label: string;
  allowed: boolean;
  grantingRoles: AccountRoleCode[];
  requiredRoles: AccountRoleCode[];
};

export function getWorkspacePermissionDetails(roleCodes: readonly string[]): WorkspacePermissionDetail[] {
  const effective = effectiveAccountRoles(roleCodes);
  return WORKSPACE_IDS.map((wsId) => {
    const requiredRoles = ACCOUNT_ROLE_CODES.filter((role) =>
      ROLE_DEFAULT_WORKSPACES[role]?.includes(wsId),
    );
    const grantingRoles = effective.filter((role) =>
      ROLE_DEFAULT_WORKSPACES[role]?.includes(wsId),
    );
    return {
      workspaceId: wsId,
      label: WORKSPACE_LABELS[wsId] ?? wsId,
      allowed: grantingRoles.length > 0,
      grantingRoles,
      requiredRoles,
    };
  });
}
