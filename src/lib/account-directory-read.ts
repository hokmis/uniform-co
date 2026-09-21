import type { SupabaseClient } from "@supabase/supabase-js";
import { ACCOUNT_ROLE_CODES, type AccountRoleCode } from "../domain/account-roles";
import type { AccountAdminLocalAccount, AccountAdminLocalRoleRow } from "../domain/account-admin-local-state";
import { retrySupabaseQueriesAfterSessionRefresh, type SupabaseSessionError } from "./supabase-session";
import { shouldProbeReadModel, shouldUseLegacyReadModel } from "./read-model-rollout";

export type AccountDirectoryReadResult = {
  accounts: AccountAdminLocalAccount[];
  roleRows: AccountAdminLocalRoleRow[];
  error: SupabaseSessionError | null;
  usedLegacyFallback: boolean;
};

const viewSelect = "id,auth_user_id,login_name,display_name,email_snapshot,is_active,role_codes";
const accountSelect = "id,auth_user_id,login_name,display_name,email_snapshot,is_active";

function isRoleCode(value: unknown): value is AccountRoleCode {
  return typeof value === "string" && (ACCOUNT_ROLE_CODES as readonly string[]).includes(value);
}

function mapAccounts(rows: unknown[]): AccountAdminLocalAccount[] {
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    auth_user_id: typeof row.auth_user_id === "string" ? row.auth_user_id : null,
    login_name: typeof row.login_name === "string" ? row.login_name : null,
    display_name: String(row.display_name ?? ""),
    email_snapshot: typeof row.email_snapshot === "string" ? row.email_snapshot : null,
    is_active: row.is_active === true,
  }));
}

function mapRoles(rows: unknown[]): AccountAdminLocalRoleRow[] {
  return rows
    .flatMap((row) => {
      const source = row as { account_id?: unknown; role_code?: unknown };
      return typeof source.account_id === "string" && isRoleCode(source.role_code)
        ? [{ account_id: source.account_id, role_code: source.role_code }]
        : [];
    });
}

async function loadLegacyDirectory(client: SupabaseClient): Promise<AccountDirectoryReadResult> {
  const [accountResult, roleResult] = await retrySupabaseQueriesAfterSessionRefresh(
    client,
    () => Promise.all([
      client.from("app_accounts").select(accountSelect).order("display_name"),
      client.from("user_roles").select("account_id,role_code").order("account_id"),
    ]),
  );
  return {
    accounts: mapAccounts(accountResult.data ?? []),
    roleRows: mapRoles(roleResult.data ?? []),
    error: accountResult.error ?? roleResult.error,
    usedLegacyFallback: true,
  };
}

/**
 * Reads the account directory and stored roles through one server-shaped view.
 * The existing two-read path remains only while 0121 rolls out; a real
 * permission or schema error from the deployed view is never hidden by it.
 */
export async function loadAccountDirectory(client: SupabaseClient): Promise<AccountDirectoryReadResult> {
  const viewName = "v_account_directory";
  if (!shouldProbeReadModel(client, viewName)) return loadLegacyDirectory(client);

  const [viewResult] = await retrySupabaseQueriesAfterSessionRefresh(
    client,
    async () => [await client.from("v_account_directory")
      .select(viewSelect)
      .order("display_name")] as const,
  );
  const useLegacyFallback = shouldUseLegacyReadModel(client, viewName, viewResult.error);
  if (!viewResult.error) {
    const rows = (viewResult.data ?? []) as Array<Record<string, unknown>>;
    return {
      accounts: mapAccounts(rows),
      roleRows: rows.flatMap((row) => {
        const accountId = typeof row.id === "string" ? row.id : null;
        const roleCodes = Array.isArray(row.role_codes) ? row.role_codes.filter(isRoleCode) : [];
        return accountId ? roleCodes.map((roleCode) => ({ account_id: accountId, role_code: roleCode })) : [];
      }),
      error: null,
      usedLegacyFallback: false,
    };
  }
  if (!useLegacyFallback) {
    return { accounts: [], roleRows: [], error: viewResult.error, usedLegacyFallback: false };
  }
  return loadLegacyDirectory(client);
}
