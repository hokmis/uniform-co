import { effectiveAccountRoles } from "./account-roles";

export type AccountDirectoryRecord = {
  id: string;
  loginName: string;
  displayName: string;
  email: string;
  isActive: boolean;
  authBound: boolean;
  roles: string[];
};

export type AccountDirectoryAccount = {
  id: string;
  login_name: string | null;
  display_name: string;
  email_snapshot: string | null;
  is_active: boolean;
  auth_user_id: string | null;
};

export type AccountDirectoryRoleRow = {
  account_id: string;
  role_code: string;
};

/**
 * Build the visible directory once per data change instead of filtering every
 * role row once for every account during each render.
 */
export function buildAccountDirectoryRows(
  accounts: readonly AccountDirectoryAccount[],
  roleRows: readonly AccountDirectoryRoleRow[],
): AccountDirectoryRecord[] {
  const rolesByAccount = new Map<string, string[]>();
  for (const roleRow of roleRows) {
    const roles = rolesByAccount.get(roleRow.account_id) ?? [];
    roles.push(roleRow.role_code);
    rolesByAccount.set(roleRow.account_id, roles);
  }

  return accounts.map((account) => ({
    id: account.id,
    loginName: account.login_name ?? "",
    displayName: account.display_name,
    email: account.email_snapshot ?? "",
    isActive: account.is_active,
    authBound: Boolean(account.auth_user_id),
    roles: effectiveAccountRoles(rolesByAccount.get(account.id) ?? []),
  }));
}

export type AccountDirectoryStatusFilter = "ALL" | "ACTIVE" | "INACTIVE";
export type AccountDirectorySortKey = "display_name" | "login_name" | "roles" | "status" | "auth";
export type AccountDirectorySortDirection = "asc" | "desc";

export function filterAccountDirectory(
  rows: readonly AccountDirectoryRecord[],
  query: string,
  status: AccountDirectoryStatusFilter,
): AccountDirectoryRecord[] {
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-TW");
  return rows.filter((row) => {
    if (status === "ACTIVE" && !row.isActive) return false;
    if (status === "INACTIVE" && row.isActive) return false;
    if (!normalizedQuery) return true;
    return [row.loginName, row.displayName, row.email, row.roles.join(" ")]
      .join(" ")
      .toLocaleLowerCase("zh-TW")
      .includes(normalizedQuery);
  });
}

export function sortAccountDirectory(
  rows: readonly AccountDirectoryRecord[],
  sortKey: AccountDirectorySortKey,
  direction: AccountDirectorySortDirection,
): AccountDirectoryRecord[] {
  const factor = direction === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => {
    const leftValue = accountDirectorySortValue(left, sortKey);
    const rightValue = accountDirectorySortValue(right, sortKey);
    return leftValue.localeCompare(rightValue, "zh-TW", { numeric: true, sensitivity: "base" }) * factor;
  });
}

function accountDirectorySortValue(row: AccountDirectoryRecord, sortKey: AccountDirectorySortKey): string {
  if (sortKey === "login_name") return row.loginName;
  if (sortKey === "roles") return row.roles.join("、");
  if (sortKey === "status") return row.isActive ? "啟用" : "停用";
  if (sortKey === "auth") return row.authBound ? "已綁定登入" : "未綁定登入";
  return row.displayName;
}
