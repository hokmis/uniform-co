import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { canonicalFingerprint } from "@/src/lib/fingerprint";
import { authEmailForAccountLogin, normalizeAccountLogin } from "@/src/lib/account-login";

export const ACCOUNT_ROLES = [
  "SYSTEM_ADMIN",
  "HR",
  "WAREHOUSE",
  "PROCUREMENT",
  "CEO",
  "DEMAND_COORDINATOR",
] as const;

export type AccountRole = (typeof ACCOUNT_ROLES)[number];

export type AccountAdminOperation =
  | { operation: "create"; login_name: string; email: string | null; display_name: string; password: string; role_codes: AccountRole[]; reason: string; idempotency_key: string }
  | { operation: "update_profile"; account_id: string; login_name: string; email: string | null; display_name: string; reason: string; idempotency_key: string }
  | { operation: "set_password"; account_id: string; password: string; reason: string; idempotency_key: string }
  | { operation: "set_status"; account_id: string; is_active: boolean; reason: string; idempotency_key: string }
  | { operation: "delete"; account_id: string; reason: string; idempotency_key: string }
  | { operation: "set_role"; account_id: string; role_code: AccountRole; is_enabled: boolean; reason: string; idempotency_key: string }
  | { operation: "set_roles"; account_id: string; role_codes: AccountRole[]; reason: string; idempotency_key: string }
  | { operation: "set_scope"; account_id: string; institution_id: string; department_id: string; is_enabled: boolean; reason: string; idempotency_key: string }
  | { operation: "rebind"; account_id: string; new_auth_user_id: string | null; reason: string; recovery_ticket: string | null; idempotency_key: string };

export type AccountRecord = {
  id: string;
  auth_user_id: string | null;
  login_name: string | null;
  display_name: string;
  email_snapshot: string | null;
  is_active: boolean;
};

export type AccountAdminResult = {
  account?: AccountRecord;
  warning?: string;
};

export class AccountAdminError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "AccountAdminError";
    this.status = status;
  }
}

export type AccountAdminActor = {
  user: User;
  accountId: string;
};

type AccountAdminClient = SupabaseClient;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function textValue(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new AccountAdminError(`${label}格式不正確。`);
  }
  const result = value.trim();
  if (!result || result.length > maxLength) {
    throw new AccountAdminError(`${label}為必填，且不可超過 ${maxLength} 個字元。`);
  }
  return result;
}

function uuidValue(value: unknown, label: string): string {
  const result = textValue(value, label, 36);
  if (!UUID_PATTERN.test(result)) {
    throw new AccountAdminError(`${label}必須是有效的 UUID。`);
  }
  return result;
}

function emailValue(value: unknown): string {
  const result = textValue(value, "Email", 320).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) {
    throw new AccountAdminError("Email 格式不正確。");
  }
  return result;
}

function optionalEmailValue(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return emailValue(value);
}

function loginNameValue(value: unknown): string {
  if (typeof value !== "string") {
    throw new AccountAdminError("登入帳號格式不正確。");
  }
  const result = normalizeAccountLogin(value);
  if (!result) {
    throw new AccountAdminError("登入帳號須為 2–50 個小寫英數字。");
  }
  return result;
}

function passwordValue(value: unknown): string {
  if (typeof value !== "string" || value.length < 6 || value.length > 256) {
    throw new AccountAdminError("密碼至少 6 個字元，且不可超過 256 個字元。");
  }
  return value;
}

function reasonValue(value: unknown): string {
  return textValue(value, "操作理由", 500);
}

function idempotencyValue(value: unknown): string {
  return textValue(value, "冪等鍵", 180);
}

function roleValue(value: unknown): AccountRole {
  if (typeof value !== "string" || !ACCOUNT_ROLES.includes(value as AccountRole)) {
    throw new AccountAdminError("角色不在允許清單內。");
  }
  return value as AccountRole;
}

function roleListValue(value: unknown): AccountRole[] {
  if (!Array.isArray(value)) {
    throw new AccountAdminError("角色清單格式不正確。");
  }
  const result = [...new Set(value.map(roleValue))].sort();
  if (result.length === 0) {
    throw new AccountAdminError("請至少選擇一個角色權限。");
  }
  return result;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new AccountAdminError(`${label}格式不正確。`);
  }
  return value;
}

function optionalText(value: unknown, label: string, maxLength: number): string | null {
  if (value === null || value === undefined || value === "") return null;
  return textValue(value, label, maxLength);
}

function normalizeOperation(input: AccountAdminOperation): AccountAdminOperation {
  if (!input || typeof input !== "object" || typeof input.operation !== "string") {
    throw new AccountAdminError("帳號管理操作不正確。");
  }
  switch (input.operation) {
    case "create": {
      const loginName = loginNameValue(input.login_name);
      const displayName = optionalText(input.display_name, "顯示名稱", 200) ?? loginName;
      return {
        operation: "create",
        login_name: loginName,
        email: optionalEmailValue(input.email),
        display_name: displayName,
        password: passwordValue(input.password),
        role_codes: roleListValue(input.role_codes),
        reason: reasonValue(input.reason),
        idempotency_key: idempotencyValue(input.idempotency_key),
      };
    }
    case "update_profile":
      return {
        operation: "update_profile",
        account_id: uuidValue(input.account_id, "帳號 ID"),
        login_name: loginNameValue(input.login_name),
        email: optionalEmailValue(input.email),
        display_name: textValue(input.display_name, "顯示名稱", 200),
        reason: reasonValue(input.reason),
        idempotency_key: idempotencyValue(input.idempotency_key),
      };
    case "set_password":
      return {
        operation: "set_password",
        account_id: uuidValue(input.account_id, "帳號 ID"),
        password: passwordValue(input.password),
        reason: reasonValue(input.reason),
        idempotency_key: idempotencyValue(input.idempotency_key),
      };
    case "set_status":
      return {
        operation: "set_status",
        account_id: uuidValue(input.account_id, "帳號 ID"),
        is_active: booleanValue(input.is_active, "帳號狀態"),
        reason: reasonValue(input.reason),
        idempotency_key: idempotencyValue(input.idempotency_key),
      };
    case "delete":
      return {
        operation: "delete",
        account_id: uuidValue(input.account_id, "帳號 ID"),
        reason: reasonValue(input.reason),
        idempotency_key: idempotencyValue(input.idempotency_key),
      };
    case "set_role":
      return {
        operation: "set_role",
        account_id: uuidValue(input.account_id, "帳號 ID"),
        role_code: roleValue(input.role_code),
        is_enabled: booleanValue(input.is_enabled, "角色狀態"),
        reason: reasonValue(input.reason),
        idempotency_key: idempotencyValue(input.idempotency_key),
      };
    case "set_roles":
      return {
        operation: "set_roles",
        account_id: uuidValue(input.account_id, "帳號 ID"),
        role_codes: roleListValue(input.role_codes),
        reason: reasonValue(input.reason),
        idempotency_key: idempotencyValue(input.idempotency_key),
      };
    case "set_scope":
      return {
        operation: "set_scope",
        account_id: uuidValue(input.account_id, "帳號 ID"),
        institution_id: uuidValue(input.institution_id, "機構 ID"),
        department_id: uuidValue(input.department_id, "部門 ID"),
        is_enabled: booleanValue(input.is_enabled, "範圍狀態"),
        reason: reasonValue(input.reason),
        idempotency_key: idempotencyValue(input.idempotency_key),
      };
    case "rebind":
      return {
        operation: "rebind",
        account_id: uuidValue(input.account_id, "帳號 ID"),
        new_auth_user_id: input.new_auth_user_id === null ? null : uuidValue(input.new_auth_user_id, "新的 Auth user UUID"),
        reason: reasonValue(input.reason),
        recovery_ticket: optionalText(input.recovery_ticket, "Recovery ticket", 200),
        idempotency_key: idempotencyValue(input.idempotency_key),
      };
    default:
      throw new AccountAdminError("不支援的帳號管理操作。");
  }
}

export function createCallerClient(authHeader: string | null): AccountAdminClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new AccountAdminError("伺服器尚未設定 Supabase URL／anon key。", 503);
  }
  if (!authHeader || !/^Bearer\s+\S+$/i.test(authHeader)) {
    throw new AccountAdminError("登入工作階段不存在或已過期。", 401);
  }
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { headers: { Authorization: authHeader } },
  });
}

export function createAuthAdminClient(): AccountAdminClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
  if (!url || !serviceRoleKey) {
    throw new AccountAdminError("尚未設定 Vercel 的 SUPABASE_SERVICE_ROLE_KEY；帳號建立與密碼管理暫不可用。", 503);
  }
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

export async function authorizeSystemAdmin(client: AccountAdminClient): Promise<AccountAdminActor> {
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) {
    throw new AccountAdminError("登入工作階段不存在或已過期。", 401);
  }
  const { data: account, error: accountError } = await client
    .from("app_accounts")
    .select("id")
    .eq("auth_user_id", data.user.id)
    .eq("is_active", true)
    .maybeSingle();
  if (accountError || !account) {
    throw new AccountAdminError("目前登入帳號未綁定有效的業務帳號。", 403);
  }
  const { data: role, error: roleError } = await client
    .from("user_roles")
    .select("account_id")
    .eq("account_id", account.id)
    .eq("role_code", "SYSTEM_ADMIN")
    .maybeSingle();
  if (roleError || !role) {
    throw new AccountAdminError("需要 SYSTEM_ADMIN 權限才能使用帳號管理。", 403);
  }
  return { user: data.user, accountId: account.id };
}

async function rpc<T>(client: AccountAdminClient, functionName: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.rpc(functionName, args);
  if (error) {
    throw new AccountAdminError(error.message, 400);
  }
  return data as T;
}

async function getAccount(client: AccountAdminClient, accountId: string): Promise<AccountRecord> {
  const { data, error } = await client
    .from("app_accounts")
    .select("id,auth_user_id,login_name,display_name,email_snapshot,is_active")
    .eq("id", accountId)
    .maybeSingle();
  if (error || !data) {
    throw new AccountAdminError("找不到指定的業務帳號。", 404);
  }
  return data as AccountRecord;
}

async function recordSecurityEvent(
  client: AccountAdminClient,
  accountId: string,
  action: "ACCOUNT_AUTH_CREATED" | "ACCOUNT_PASSWORD_CHANGED" | "ACCOUNT_AUTH_ENABLED" | "ACCOUNT_AUTH_DISABLED" | "ACCOUNT_AUTH_DELETED",
  reason: string,
  idempotencyKey: string,
): Promise<void> {
  const payload = { account_id: accountId, action, reason };
  await rpc(client, "record_account_security_event", {
    p_account_id: accountId,
    p_action: action,
    p_reason: reason,
    p_idempotency_key: `${idempotencyKey}-AUTH`,
    p_request_fingerprint: await canonicalFingerprint(payload),
  });
}

async function findAuthUserByCreateKey(adminClient: AccountAdminClient, authEmail: string, createKey: string): Promise<User | null> {
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await adminClient.auth.admin.listUsers({ page, perPage: 100 });
    if (error) throw new AccountAdminError(`查詢 Auth 使用者失敗：${error.message}`, 502);
    const match = data.users.find((user) => user.email?.toLowerCase() === authEmail && user.user_metadata?.uniform_create_key === createKey);
    if (match) return match;
    if (data.users.length < 100) return null;
  }
  return null;
}

async function createAccount(
  client: AccountAdminClient,
  adminClient: AccountAdminClient,
  operation: Extract<AccountAdminOperation, { operation: "create" }>,
): Promise<AccountAdminResult> {
  const authEmail = authEmailForAccountLogin(operation.login_name);
  const userMetadata = {
    display_name: operation.display_name,
    login_name: operation.login_name,
    uniform_create_key: operation.idempotency_key,
  };
  let authUser: User | null = null;
  let createdInThisRequest = false;
  const created = await adminClient.auth.admin.createUser({
    email: authEmail,
    password: operation.password,
    email_confirm: true,
    user_metadata: userMetadata,
  });
  if (created.error) {
    authUser = await findAuthUserByCreateKey(adminClient, authEmail, operation.idempotency_key);
    if (!authUser) {
      throw new AccountAdminError(`建立登入身份失敗：${created.error.message}`, 502);
    }
  } else {
    authUser = created.data.user;
    createdInThisRequest = true;
  }
  if (!authUser) throw new AccountAdminError("Auth 使用者建立結果不完整。", 502);

  const payload = {
    auth_user_id: authUser.id,
    login_name: operation.login_name,
    display_name: operation.display_name,
    email_snapshot: operation.email,
    role_codes: operation.role_codes,
    reason: operation.reason,
  };
  try {
    const account = await rpc<AccountRecord>(client, "create_account_with_roles", {
      p_auth_user_id: authUser.id,
      p_login_name: operation.login_name,
      p_display_name: operation.display_name,
      p_email_snapshot: operation.email,
      p_role_codes: operation.role_codes,
      p_reason: operation.reason,
      p_idempotency_key: operation.idempotency_key,
      p_request_fingerprint: await canonicalFingerprint(payload),
    });
    let warning: string | undefined;
    try {
      await recordSecurityEvent(client, account.id, "ACCOUNT_AUTH_CREATED", "由帳號管理模組建立登入身份", operation.idempotency_key);
    } catch {
      warning = "業務帳號已建立，但 Auth 建立事件尚未寫入稽核；請稍後重試稽核同步。";
    }
    return { account, warning };
  } catch (error) {
    if (createdInThisRequest) {
      await adminClient.auth.admin.deleteUser(authUser.id).catch(() => undefined);
    }
    throw error;
  }
}

async function updateProfile(
  client: AccountAdminClient,
  adminClient: AccountAdminClient,
  operation: Extract<AccountAdminOperation, { operation: "update_profile" }>,
): Promise<AccountAdminResult> {
  const current = await getAccount(client, operation.account_id);
  let currentAuthEmail: string | null = null;
  let currentUserMetadata: Record<string, unknown> | null = null;
  const loginChanged = current.login_name !== operation.login_name;
  if (current.auth_user_id) {
    const authUser = await adminClient.auth.admin.getUserById(current.auth_user_id);
    if (authUser.error || !authUser.data.user) {
      throw new AccountAdminError(`讀取原登入身份失敗：${authUser.error?.message ?? "Auth 使用者不存在"}`, 502);
    }
    currentAuthEmail = authUser.data.user.email ?? null;
    currentUserMetadata = authUser.data.user.user_metadata;
    const updated = await adminClient.auth.admin.updateUserById(current.auth_user_id, {
      ...(loginChanged ? { email: authEmailForAccountLogin(operation.login_name), email_confirm: true } : {}),
      user_metadata: {
        ...authUser.data.user.user_metadata,
        display_name: operation.display_name,
        login_name: operation.login_name,
      },
    });
    if (updated.error) throw new AccountAdminError(`更新登入身份失敗：${updated.error.message}`, 502);
  }
  const payload = {
    account_id: operation.account_id,
    login_name: operation.login_name,
    display_name: operation.display_name,
    email_snapshot: operation.email,
    reason: operation.reason,
  };
  try {
    const account = await rpc<AccountRecord>(client, "update_account_profile_v2", {
      p_account_id: operation.account_id,
      p_login_name: operation.login_name,
      p_display_name: operation.display_name,
      p_email_snapshot: operation.email,
      p_reason: operation.reason,
      p_idempotency_key: operation.idempotency_key,
      p_request_fingerprint: await canonicalFingerprint(payload),
    });
    return { account };
  } catch (error) {
    if (current.auth_user_id) {
      await adminClient.auth.admin.updateUserById(current.auth_user_id, {
        ...(loginChanged && currentAuthEmail ? { email: currentAuthEmail, email_confirm: true } : {}),
        ...(currentUserMetadata ? { user_metadata: currentUserMetadata } : {}),
      }).catch(() => undefined);
    }
    throw error;
  }
}

async function setPassword(
  client: AccountAdminClient,
  adminClient: AccountAdminClient,
  operation: Extract<AccountAdminOperation, { operation: "set_password" }>,
): Promise<AccountAdminResult> {
  const current = await getAccount(client, operation.account_id);
  if (!current.auth_user_id) throw new AccountAdminError("此帳號尚未綁定登入身份，請先完成 Auth 綁定。", 409);
  const updated = await adminClient.auth.admin.updateUserById(current.auth_user_id, { password: operation.password });
  if (updated.error) throw new AccountAdminError(`修改密碼失敗：${updated.error.message}`, 502);
  let warning: string | undefined;
  try {
    await recordSecurityEvent(client, current.id, "ACCOUNT_PASSWORD_CHANGED", operation.reason, operation.idempotency_key);
  } catch {
    warning = "密碼已更新，但密碼異動稽核尚未寫入；請稍後重試稽核同步。";
  }
  return { account: current, warning };
}

async function setStatus(
  client: AccountAdminClient,
  adminClient: AccountAdminClient,
  operation: Extract<AccountAdminOperation, { operation: "set_status" }>,
): Promise<AccountAdminResult> {
  const current = await getAccount(client, operation.account_id);
  const account = await rpc<AccountRecord>(client, "set_account_status", {
    p_account_id: operation.account_id,
    p_is_active: operation.is_active,
    p_reason: operation.reason,
    p_idempotency_key: operation.idempotency_key,
    p_request_fingerprint: await canonicalFingerprint({ account_id: operation.account_id, is_active: operation.is_active, reason: operation.reason }),
  });
  if (!current.auth_user_id) return { account };
  const authUpdate = await adminClient.auth.admin.updateUserById(current.auth_user_id, { ban_duration: operation.is_active ? "none" : "876000h" });
  if (authUpdate.error) {
    return { account, warning: `業務帳號已${operation.is_active ? "啟用" : "停用"}，但 Auth 登入限制同步失敗：${authUpdate.error.message}` };
  }
  let warning: string | undefined;
  try {
    await recordSecurityEvent(client, current.id, operation.is_active ? "ACCOUNT_AUTH_ENABLED" : "ACCOUNT_AUTH_DISABLED", operation.reason, operation.idempotency_key);
  } catch {
    warning = "帳號狀態與 Auth 登入限制已更新，但 Auth 異動稽核尚未寫入。";
  }
  return { account, warning };
}

async function deleteAccount(
  client: AccountAdminClient,
  adminClient: AccountAdminClient,
  actor: AccountAdminActor,
  operation: Extract<AccountAdminOperation, { operation: "delete" }>,
): Promise<AccountAdminResult> {
  if (operation.account_id === actor.accountId) {
    throw new AccountAdminError("為避免自我鎖定，不能刪除目前登入中的 SYSTEM_ADMIN。", 409);
  }
  const current = await getAccount(client, operation.account_id);
  const account = await rpc<AccountRecord>(client, "set_account_status", {
    p_account_id: operation.account_id,
    p_is_active: false,
    p_reason: operation.reason,
    p_idempotency_key: operation.idempotency_key,
    p_request_fingerprint: await canonicalFingerprint({ account_id: operation.account_id, is_active: false, reason: operation.reason }),
  });
  if (!current.auth_user_id) return { account, warning: "業務帳號已停用；此帳號原本沒有 Auth 登入身份。" };
  const deleted = await adminClient.auth.admin.deleteUser(current.auth_user_id);
  if (deleted.error) {
    return { account, warning: `業務帳號已停用，但 Auth 登入身份刪除失敗：${deleted.error.message}` };
  }
  let warning: string | undefined;
  try {
    await rpc<AccountRecord>(client, "rebind_account_auth", {
      p_account_id: current.id,
      p_new_auth_user_id: null,
      p_reason: operation.reason,
      p_recovery_ticket: null,
      p_idempotency_key: `${operation.idempotency_key}-UNBIND`,
      p_request_fingerprint: await canonicalFingerprint({ account_id: current.id, new_auth_user_id: null, reason: operation.reason, recovery_ticket: null }),
    });
    await recordSecurityEvent(client, current.id, "ACCOUNT_AUTH_DELETED", operation.reason, operation.idempotency_key);
  } catch {
    warning = "Auth 登入身份已刪除，但資料庫綁定歷史尚未完成同步；請由 SYSTEM_ADMIN 重新執行解除綁定。";
  }
  return { account: { ...account, auth_user_id: null }, warning };
}

async function setRole(client: AccountAdminClient, operation: Extract<AccountAdminOperation, { operation: "set_role" }>): Promise<AccountAdminResult> {
  const account = await rpc<AccountRecord>(client, "set_account_role", {
    p_account_id: operation.account_id,
    p_role_code: operation.role_code,
    p_is_enabled: operation.is_enabled,
    p_reason: operation.reason,
    p_idempotency_key: operation.idempotency_key,
    p_request_fingerprint: await canonicalFingerprint({ account_id: operation.account_id, role_code: operation.role_code, is_enabled: operation.is_enabled, reason: operation.reason }),
  });
  return { account };
}

async function setRoles(client: AccountAdminClient, operation: Extract<AccountAdminOperation, { operation: "set_roles" }>): Promise<AccountAdminResult> {
  const account = await rpc<AccountRecord>(client, "replace_account_roles", {
    p_account_id: operation.account_id,
    p_role_codes: operation.role_codes,
    p_reason: operation.reason,
    p_idempotency_key: operation.idempotency_key,
    p_request_fingerprint: await canonicalFingerprint({
      account_id: operation.account_id,
      role_codes: operation.role_codes,
      reason: operation.reason,
    }),
  });
  return { account };
}

async function setScope(client: AccountAdminClient, operation: Extract<AccountAdminOperation, { operation: "set_scope" }>): Promise<AccountAdminResult> {
  await rpc(client, "set_coordinator_scope", {
    p_account_id: operation.account_id,
    p_institution_id: operation.institution_id,
    p_department_id: operation.department_id,
    p_is_enabled: operation.is_enabled,
    p_reason: operation.reason,
    p_idempotency_key: operation.idempotency_key,
    p_request_fingerprint: await canonicalFingerprint({ account_id: operation.account_id, institution_id: operation.institution_id, department_id: operation.department_id, is_enabled: operation.is_enabled, reason: operation.reason }),
  });
  return { account: await getAccount(client, operation.account_id) };
}

async function rebind(client: AccountAdminClient, operation: Extract<AccountAdminOperation, { operation: "rebind" }>): Promise<AccountAdminResult> {
  const account = await rpc<AccountRecord>(client, "rebind_account_auth", {
    p_account_id: operation.account_id,
    p_new_auth_user_id: operation.new_auth_user_id,
    p_reason: operation.reason,
    p_recovery_ticket: operation.recovery_ticket,
    p_idempotency_key: operation.idempotency_key,
    p_request_fingerprint: await canonicalFingerprint({ account_id: operation.account_id, new_auth_user_id: operation.new_auth_user_id, reason: operation.reason, recovery_ticket: operation.recovery_ticket }),
  });
  return { account };
}

export async function executeAccountAdminOperation(
  client: AccountAdminClient,
  authAdminClient: AccountAdminClient | null,
  actor: AccountAdminActor,
  input: AccountAdminOperation,
): Promise<AccountAdminResult> {
  const operation = normalizeOperation(input);
  switch (operation.operation) {
    case "create":
      return createAccount(client, authAdminClient ?? createAuthAdminClient(), operation);
    case "update_profile":
      return updateProfile(client, authAdminClient ?? createAuthAdminClient(), operation);
    case "set_password":
      return setPassword(client, authAdminClient ?? createAuthAdminClient(), operation);
    case "set_status":
      return setStatus(client, authAdminClient ?? createAuthAdminClient(), operation);
    case "delete":
      return deleteAccount(client, authAdminClient ?? createAuthAdminClient(), actor, operation);
    case "set_role":
      return setRole(client, operation);
    case "set_roles":
      return setRoles(client, operation);
    case "set_scope":
      return setScope(client, operation);
    case "rebind":
      return rebind(client, operation);
  }
}
