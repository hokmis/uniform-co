import { createServerClient, type SetAllCookies } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AccountAdminError,
  createAuthAdminClient,
} from "./account-admin";
import {
  SSO_TARGET_ORIGIN,
  SsoError,
  type CentralSsoIdentity,
  type LocalSsoAccount,
  type SsoLoginAccountLookupOptions,
  type SsoLoginSessionOptions,
  type SsoDiagnosticStage,
  type TargetSessionSnapshot,
} from "./sso";

type AccountRow = {
  id: string;
  auth_user_id: string | null;
  login_name: string | null;
  display_name: string;
  email_snapshot: string | null;
  is_active: boolean;
  user_roles?: Array<{ role_code?: string | null }> | null;
};

const ACCOUNT_SELECT = "id,auth_user_id,login_name,display_name,email_snapshot,is_active,user_roles(role_code)";
const ACCOUNT_SELECT_WITHOUT_LOGIN = "id,auth_user_id,display_name,email_snapshot,is_active,user_roles(role_code)";

export type SsoAdapter = {
  findLocalSsoAccount: (identity: CentralSsoIdentity, options?: SsoLoginAccountLookupOptions) => Promise<LocalSsoAccount | null>;
  getTargetSessionUser: () => Promise<TargetSessionSnapshot | null>;
  getCurrentLocalSsoAccount: () => Promise<LocalSsoAccount>;
  issueTargetSupabaseSession: (account: LocalSsoAccount, options?: SsoLoginSessionOptions) => Promise<string>;
};

export function createSsoAdapter(): SsoAdapter {
  let adminClientPromise: Promise<SupabaseClient> | undefined;
  let targetSessionClientPromise: Promise<SupabaseClient> | undefined;
  let targetSessionUserPromise: Promise<TargetSessionSnapshot | null> | undefined;
  const getAdminClient = () => {
    adminClientPromise ??= getVerifiedAuthAdminClient();
    return adminClientPromise;
  };
  const getTargetSessionClient = () => {
    targetSessionClientPromise ??= createTargetSessionClient();
    return targetSessionClientPromise;
  };
  const getTargetSessionUser = () => {
    targetSessionUserPromise ??= readTargetSessionUser(getTargetSessionClient());
    return targetSessionUserPromise;
  };

  return {
    findLocalSsoAccount: async (identity, options) => findLocalSsoAccountWithClient(await getAdminClient(), identity, options),
    getTargetSessionUser,
    getCurrentLocalSsoAccount: async () => getCurrentLocalSsoAccountWithAdminGetter(getAdminClient, getTargetSessionUser),
    issueTargetSupabaseSession: async (account, options) => issueTargetSupabaseSessionWithClient(await getAdminClient(), account, options, getTargetSessionClient),
  };
}

export async function findLocalSsoAccount(identity: CentralSsoIdentity): Promise<LocalSsoAccount | null> {
  return findLocalSsoAccountWithClient(await getVerifiedAuthAdminClient(), identity);
}

async function findLocalSsoAccountWithClient(
  client: SupabaseClient,
  identity: CentralSsoIdentity,
  options?: SsoLoginAccountLookupOptions,
): Promise<LocalSsoAccount | null> {
  const row = await findAccountRow(client, identity);
  if (!row) return null;
  if (typeof row.auth_user_id !== "string") {
    const hasRole = await accountHasRoleForRow(client, row);
    return {
      id: row.id,
      authUserId: "",
      authEmail: "",
      localEmail: row.email_snapshot,
      loginName: row.login_name,
      displayName: row.display_name,
      isActive: row.is_active,
      hasRole,
    };
  }

  if (options?.targetAuthUserId === row.auth_user_id) {
    const hasRole = await accountHasRoleForRow(client, row);
    return localSsoAccountFromRow(row, hasRole, row.email_snapshot ?? "");
  }

  const [hasRole, authUser] = await Promise.all([
    accountHasRoleForRow(client, row),
    client.auth.admin.getUserById(row.auth_user_id),
  ]);
  if (authUser.error) {
    throw new SsoError(
      "本地登入身份資料暫時無法讀取。",
      "SSO_CONFIGURATION_ERROR",
      503,
      "local_auth_user_query_failed",
    );
  }
  if (!authUser.data.user?.email) {
    return localSsoAccountFromRow(row, hasRole, "");
  }
  return localSsoAccountFromRow(row, hasRole, authUser.data.user.email);
}

export async function getCurrentLocalSsoAccount(): Promise<LocalSsoAccount> {
  return getCurrentLocalSsoAccountWithAdminGetter(
    () => getVerifiedAuthAdminClient(),
    () => readTargetSessionUser(createTargetSessionClient()),
  );
}

async function getCurrentLocalSsoAccountWithAdminGetter(
  getAdminClient: () => Promise<SupabaseClient>,
  getTargetSessionUser: () => Promise<TargetSessionSnapshot | null>,
): Promise<LocalSsoAccount> {
  const targetSessionUser = await getTargetSessionUser();
  if (!targetSessionUser) {
    throw new SsoError("請先使用目標系統原有登入方式登入。", "TARGET_SESSION_REQUIRED", 401);
  }

  const adminClient = await getAdminClient();
  const rows = await queryAccountRows(adminClient, "auth_user_id", targetSessionUser.id);
  if (rows.length > 1) {
    throw new SsoError("目前登入身份對應多筆本地帳號。", "AMBIGUOUS_LOCAL_ACCOUNT", 403, "local_account_not_unique");
  }
  if (rows.length !== 1) {
    throw new SsoError("目前登入身份未綁定有效的本地帳號。", "LOCAL_ACCOUNT_NOT_FOUND", 403);
  }
  const row = rows[0] as AccountRow;
  const hasRole = await accountHasRoleForRow(adminClient, row);
  return {
    id: row.id,
    authUserId: targetSessionUser.id,
    authEmail: targetSessionUser.email ?? "",
    localEmail: row.email_snapshot,
    loginName: row.login_name,
    displayName: row.display_name,
    isActive: row.is_active,
    hasRole,
  };
}

export async function issueTargetSupabaseSession(account: LocalSsoAccount): Promise<string> {
  return issueTargetSupabaseSessionWithClient(await getVerifiedAuthAdminClient(), account);
}

async function issueTargetSupabaseSessionWithClient(
  adminClient: SupabaseClient,
  account: LocalSsoAccount,
  options?: SsoLoginSessionOptions,
  getSessionClient: () => Promise<SupabaseClient> = createTargetSessionClient,
): Promise<string> {
  const sessionClient = await getSessionClient();
  const targetAuthUserId = options
    ? options.targetAuthUserId
    : (await readTargetSessionUser(Promise.resolve(sessionClient)))?.id ?? null;
  if (targetAuthUserId === account.authUserId) {
    return new URL("/app", SSO_TARGET_ORIGIN).toString();
  }
  if (!account.authEmail) {
    throw new SsoError("本地帳號沒有有效的 Supabase Auth 身份。", "LOCAL_ACCOUNT_UNBOUND", 403);
  }

  const { data, error } = await adminClient.auth.admin.generateLink({
    type: "magiclink",
    email: account.authEmail,
  });
  const hashedToken = data?.properties?.hashed_token;
  if (error || !hashedToken) {
    throw new SsoError("目標登入 Session 暫時無法建立。", "TARGET_SESSION_UNAVAILABLE", 502);
  }

  const { data: sessionData, error: sessionError } = await sessionClient.auth.verifyOtp({
    token_hash: hashedToken,
    type: "email",
  });
  if (sessionError || sessionData.session?.user.id !== account.authUserId) {
    throw new SsoError("目標登入 Session 暫時無法建立。", "TARGET_SESSION_UNAVAILABLE", 502);
  }

  return new URL("/app", SSO_TARGET_ORIGIN).toString();
}

async function createTargetSessionClient(): Promise<SupabaseClient> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    throw new SsoError(
      "伺服器尚未設定 Supabase。",
      "SSO_CONFIGURATION_ERROR",
      503,
      "supabase_runtime_config_missing",
    );
  }

  const cookieStore = await cookies();
  return createServerClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: Parameters<SetAllCookies>[0]) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Route handlers can write the session cookies; read-only contexts simply fail closed.
        }
      },
    },
  });
}

async function readTargetSessionUser(clientPromise: Promise<SupabaseClient>): Promise<TargetSessionSnapshot | null> {
  const client = await clientPromise;
  const { data } = await client.auth.getUser();
  return data.user?.id ? { id: data.user.id, email: data.user.email ?? null } : null;
}

async function findAccountRow(client: SupabaseClient, identity: CentralSsoIdentity): Promise<AccountRow | null> {
  if (identity.localUserId) {
    const byAccountId = await queryAccountRows(client, "id", identity.localUserId);
    if (byAccountId.length > 1) throw new SsoError("本地帳號對應不唯一。", "AMBIGUOUS_LOCAL_ACCOUNT", 403, "local_account_not_unique");
    if (byAccountId[0]) return byAccountId[0];

    const byAuthId = await queryAccountRows(client, "auth_user_id", identity.localUserId);
    if (byAuthId.length > 1) throw new SsoError("本地帳號對應不唯一。", "AMBIGUOUS_LOCAL_ACCOUNT", 403, "local_account_not_unique");
    if (byAuthId[0]) return byAuthId[0];
  }

  if (!identity.email) return null;
  const byEmail = await queryAccountRows(client, "email_snapshot", identity.email);
  if (byEmail.length > 1) throw new SsoError("Email 對應的本地帳號不唯一。", "AMBIGUOUS_LOCAL_ACCOUNT", 403, "local_account_not_unique");
  if (byEmail[0]) return byEmail[0];
  return null;
}

async function accountHasRole(client: SupabaseClient, accountId: string): Promise<boolean> {
  const { data, error } = await client.from("user_roles").select("role_code").eq("account_id", accountId).limit(1);
  if (error) {
    throw new SsoError(
      "本地帳號權限資料暫時無法讀取。",
      "SSO_CONFIGURATION_ERROR",
      503,
      dataQueryDiagnosticStage(error, "local_role_query_failed"),
    );
  }
  return Boolean(data?.[0]);
}

async function accountHasRoleForRow(client: SupabaseClient, row: AccountRow): Promise<boolean> {
  if (Object.prototype.hasOwnProperty.call(row, "user_roles")) {
    return (row.user_roles ?? []).some((role) => typeof role.role_code === "string" && role.role_code.trim() !== "");
  }
  // Keep a narrow compatibility fallback for test doubles or an older API
  // schema cache that does not return the embedded relationship yet.
  return accountHasRole(client, row.id);
}

async function getVerifiedAuthAdminClient(): Promise<SupabaseClient> {
  let client: SupabaseClient;
  try {
    client = createAuthAdminClient();
  } catch (error) {
    const diagnosticStage = error instanceof AccountAdminError
      ? error.diagnosticStage ?? "supabase_admin_project_mismatch"
      : "supabase_admin_project_mismatch";
    throw new SsoError(
      "Supabase server runtime 設定無法驗證。",
      "SSO_CONFIGURATION_ERROR",
      503,
      diagnosticStage,
    );
  }
  return client;
}

function localSsoAccountFromRow(row: AccountRow, hasRole: boolean, authEmail: string): LocalSsoAccount {
  return {
    id: row.id,
    authUserId: row.auth_user_id ?? "",
    authEmail,
    localEmail: row.email_snapshot,
    loginName: row.login_name,
    displayName: row.display_name,
    isActive: row.is_active,
    hasRole,
  };
}

type AccountFilter = "id" | "auth_user_id" | "email_snapshot";

async function queryAccountRows(client: SupabaseClient, column: AccountFilter, value: string): Promise<AccountRow[]> {
  const primary = await client
    .from("app_accounts")
    .select(ACCOUNT_SELECT)
    .eq(column, value)
    .limit(2);
  if (!primary.error) return (primary.data ?? []) as AccountRow[];

  if (!isMissingLoginNameError(primary.error)) {
    throw new SsoError(
      "本地帳號資料暫時無法讀取。",
      "SSO_CONFIGURATION_ERROR",
      503,
      dataQueryDiagnosticStage(primary.error, "local_account_query_failed"),
    );
  }

  const fallback = await client
    .from("app_accounts")
    .select(ACCOUNT_SELECT_WITHOUT_LOGIN)
    .eq(column, value)
    .limit(2);
  if (fallback.error) {
    throw new SsoError(
      "本地帳號資料表欄位與目前 adapter 不一致。",
      "SSO_CONFIGURATION_ERROR",
      503,
      dataQueryDiagnosticStage(fallback.error, "local_account_schema_mismatch"),
    );
  }
  return ((fallback.data ?? []) as Omit<AccountRow, "login_name">[]).map((row) => ({ ...row, login_name: null }));
}

function isMissingLoginNameError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown; details?: unknown };
  return [candidate.message, candidate.details].some((value) =>
    typeof value === "string" && /login_name.*(does not exist|not found)|column .*login_name/i.test(value),
  ) && (candidate.code === "42703" || candidate.code === "PGRST204" || candidate.code === undefined);
}

function dataQueryDiagnosticStage(
  error: unknown,
  fallback: Extract<SsoDiagnosticStage, "local_account_query_failed" | "local_account_schema_mismatch" | "local_role_query_failed">,
): Extract<SsoDiagnosticStage, "local_account_permission_denied" | "local_account_query_failed" | "local_account_schema_mismatch" | "local_role_query_failed"> {
  if (isPermissionDeniedError(error)) return "local_account_permission_denied";
  if (isSchemaMismatchError(error)) return "local_account_schema_mismatch";
  return fallback;
}

function isPermissionDeniedError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
  if (candidate.code === "42501") return true;
  return [candidate.message, candidate.details, candidate.hint].some((value) =>
    typeof value === "string" && /permission denied|insufficient privilege|not authorized|row-level security/i.test(value),
  );
}

function isSchemaMismatchError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown; details?: unknown };
  if (candidate.code === "42703" || candidate.code === "42P01" || candidate.code === "PGRST204") return true;
  return [candidate.message, candidate.details].some((value) =>
    typeof value === "string" && /column .* (does not exist|was not found)|relation .* does not exist|schema cache/i.test(value),
  );
}
