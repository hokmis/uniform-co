import type { AccountRoleCode } from "./account-roles";

export type AccountAdminLocalAccount = {
  id: string;
  auth_user_id: string | null;
  login_name: string | null;
  display_name: string;
  email_snapshot: string | null;
  is_active: boolean;
};

export type AccountAdminLocalRoleRow = {
  account_id: string;
  role_code: AccountRoleCode;
};

export type AccountAdminLocalScopeRow = {
  account_id: string;
  institution_id: string;
  department_id: string;
};

export type AccountAdminLocalState = {
  accounts: readonly AccountAdminLocalAccount[];
  roleRows: readonly AccountAdminLocalRoleRow[];
  scopeRows: readonly AccountAdminLocalScopeRow[];
};

export type AccountAdminLocalUpdate = {
  operation: string;
  account: AccountAdminLocalAccount;
  roleCodes?: readonly AccountRoleCode[];
  roleCode?: AccountRoleCode;
  roleEnabled?: boolean;
  scope?: {
    institutionId: string;
    departmentId: string;
    enabled: boolean;
  };
};

/**
 * Apply a server-verified account mutation to the visible directory without
 * reloading unrelated account, role, scope, institution, and department data.
 * The server RPC remains authoritative; this only updates the current view.
 */
export function applyAccountAdminLocalResult(
  state: AccountAdminLocalState,
  update: AccountAdminLocalUpdate,
): AccountAdminLocalState {
  const accountIndex = state.accounts.findIndex((account) => account.id === update.account.id);
  const accounts = accountIndex < 0
    ? update.operation === "create"
      ? [...state.accounts, update.account]
      : [...state.accounts]
    : state.accounts.map((account, index) => index === accountIndex ? update.account : account);

  let roleRows = [...state.roleRows];
  if (update.operation === "create" || update.operation === "set_roles") {
    roleRows = [
      ...roleRows.filter((row) => row.account_id !== update.account.id),
      ...(update.roleCodes ?? []).map((roleCode) => ({ account_id: update.account.id, role_code: roleCode })),
    ];
  } else if (update.operation === "set_role" && update.roleCode) {
    roleRows = roleRows.filter((row) => !(row.account_id === update.account.id && row.role_code === update.roleCode));
    if (update.roleEnabled) roleRows.push({ account_id: update.account.id, role_code: update.roleCode });
  }

  let scopeRows = [...state.scopeRows];
  if (update.operation === "set_scope" && update.scope) {
    scopeRows = scopeRows.filter((row) => !(
      row.account_id === update.account.id
      && row.institution_id === update.scope?.institutionId
      && row.department_id === update.scope?.departmentId
    ));
    if (update.scope.enabled) {
      scopeRows.push({
        account_id: update.account.id,
        institution_id: update.scope.institutionId,
        department_id: update.scope.departmentId,
      });
    }
  }

  return { accounts, roleRows, scopeRows };
}
