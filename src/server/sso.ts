export const SSO_SYSTEM_CODE = "un";
export const SSO_TARGET_ORIGIN = "https://uniform-co.vercel.app";
export const CENTRAL_VERIFY_URL = "https://jyecltijflcplhzjoelh.supabase.co/functions/v1/verify-sso-ticket";
export const CENTRAL_BINDING_URL = "https://jyecltijflcplhzjoelh.supabase.co/functions/v1/complete-account-binding";
export const SSO_BINDING_TICKET_COOKIE = "uniform_sso_binding_ticket";
export const SSO_BINDING_PENDING_COOKIE = "uniform_sso_binding_pending";
export const SSO_LOGIN_TICKET_COOKIE = "uniform_sso_login_ticket";
export const SSO_LOGIN_PENDING_COOKIE = "uniform_sso_login_pending";

export type SsoFlow = "login" | "account_binding";

export const SSO_DIAGNOSTIC_STAGES = [
  "invalid_request",
  "invalid_system_code",
  "invalid_flow",
  "ticket_missing",
  "ticket_rejected",
  "target_session_missing",
  "sso_pending_state_missing",
  "supabase_runtime_config_missing",
  "supabase_target_url_invalid",
  "supabase_admin_key_invalid",
  "supabase_admin_project_mismatch",
  "local_account_permission_denied",
  "local_account_schema_mismatch",
  "local_account_query_failed",
  "local_account_missing",
  "local_account_not_unique",
  "local_account_disabled",
  "local_account_unbound",
  "local_account_unauthorized",
  "local_role_query_failed",
  "local_auth_user_query_failed",
  "target_session_create_failed",
  "central_verify_failed",
  "central_binding_failed",
  "sso_configuration_failed",
  "sso_callback_failed",
  "sso_response_invalid",
  "sso_client_request_failed",
  "sso_redirect_invalid",
] as const;

export type SsoDiagnosticStage = (typeof SSO_DIAGNOSTIC_STAGES)[number];

export type SsoRequest = {
  ticket: string | null;
  systemCode: string | null;
  flow: string | null;
};

export type CentralSsoIdentity = {
  localUserId?: string;
  email?: string;
};

export type LocalSsoAccount = {
  id: string;
  authUserId: string;
  authEmail: string;
  localEmail?: string | null;
  employeeNo?: string | null;
  loginName?: string | null;
  displayName: string;
  isActive: boolean;
  hasRole: boolean;
};

export type TargetSessionSnapshot = {
  id: string;
  email?: string | null;
};

export type SsoLoginAccountLookupOptions = {
  targetAuthUserId: string | null;
};

export type SsoLoginSessionOptions = {
  targetAuthUserId: string | null;
};

export class SsoError extends Error {
  readonly code: string;
  readonly status: number;
  readonly diagnosticStage: SsoDiagnosticStage | undefined;

  constructor(message: string, code: string, status = 400, diagnosticStage?: SsoDiagnosticStage) {
    super(message);
    this.name = "SsoError";
    this.code = code;
    this.status = status;
    this.diagnosticStage = diagnosticStage;
  }
}

export function isSsoError(error: unknown): error is SsoError {
  return error instanceof SsoError
    || (isRecord(error) && typeof error.code === "string" && typeof error.status === "number");
}

export function defaultSsoDiagnosticStage(code: string): SsoDiagnosticStage {
  const stages: Record<string, SsoDiagnosticStage> = {
    INVALID_SSO_REQUEST: "invalid_request",
    INVALID_SYSTEM_CODE: "invalid_system_code",
    INVALID_SSO_FLOW: "invalid_flow",
    MISSING_SSO_TICKET: "ticket_missing",
    INVALID_SSO_TICKET: "ticket_rejected",
    TARGET_SESSION_REQUIRED: "target_session_missing",
    SSO_PENDING_STATE_MISSING: "sso_pending_state_missing",
    SSO_CONFIGURATION_ERROR: "sso_configuration_failed",
    LOCAL_ACCOUNT_NOT_FOUND: "local_account_missing",
    LOCAL_ACCOUNT_DISABLED: "local_account_disabled",
    LOCAL_ACCOUNT_UNBOUND: "local_account_unbound",
    LOCAL_ACCOUNT_UNAUTHORIZED: "local_account_unauthorized",
    AMBIGUOUS_LOCAL_ACCOUNT: "local_account_not_unique",
    INVALID_SSO_IDENTITY: "central_verify_failed",
    TARGET_SESSION_UNAVAILABLE: "target_session_create_failed",
    CENTRAL_VERIFY_UNAVAILABLE: "central_verify_failed",
    CENTRAL_BINDING_UNAVAILABLE: "central_binding_failed",
    BINDING_NOT_ACCEPTED: "central_binding_failed",
  };
  return stages[code] ?? "sso_callback_failed";
}

export function isSsoDiagnosticStage(value: unknown): value is SsoDiagnosticStage {
  return typeof value === "string" && (SSO_DIAGNOSTIC_STAGES as readonly string[]).includes(value);
}

export type SsoLoginDependencies = {
  verifyTicket: (ticket: string) => Promise<CentralSsoIdentity>;
  getTargetSessionUser: () => Promise<TargetSessionSnapshot | null>;
  findAccount: (identity: CentralSsoIdentity, options: SsoLoginAccountLookupOptions) => Promise<LocalSsoAccount | null>;
  issueTargetSession: (account: LocalSsoAccount, options: SsoLoginSessionOptions) => Promise<string>;
};

export type AccountBindingDependencies = {
  callBindingApi: (payload: Record<string, unknown>) => Promise<unknown>;
};

export function normalizeSsoFlow(value: unknown): SsoFlow | null {
  if (value === null || value === undefined || value === "") return "login";
  if (value === "login" || value === "account_binding") return value;
  return null;
}

export function validateSsoRequest(input: SsoRequest): SsoFlow {
  if (input.systemCode !== SSO_SYSTEM_CODE) {
    throw new SsoError("SSO system code 不正確。", "INVALID_SYSTEM_CODE", 400);
  }
  const flow = normalizeSsoFlow(input.flow);
  if (!flow) {
    throw new SsoError("不支援的 SSO flow。", "INVALID_SSO_FLOW", 400);
  }
  if (!input.ticket) {
    throw new SsoError("SSO ticket 不存在或格式不正確。", "MISSING_SSO_TICKET", 400);
  }
  return flow;
}

export async function completeSsoLogin(input: SsoRequest, dependencies: SsoLoginDependencies): Promise<{ redirectTo: string }> {
  const flow = validateSsoRequest(input);
  if (flow !== "login") {
    throw new SsoError("帳號綁定票券不可用於一般登入。", "INVALID_SSO_FLOW", 400);
  }
  const ticket = input.ticket;
  if (!ticket) {
    throw new SsoError("SSO ticket 不存在或格式不正確。", "MISSING_SSO_TICKET", 400);
  }

  const [identity, targetSession] = await Promise.all([
    dependencies.verifyTicket(ticket),
    dependencies.getTargetSessionUser(),
  ]);
  const targetAuthUserId = targetSession?.id ?? null;
  const account = await dependencies.findAccount(identity, { targetAuthUserId });
  if (!account) {
    throw new SsoError("中央身份沒有對應的本地帳號。", "LOCAL_ACCOUNT_NOT_FOUND", 403);
  }
  if (!account.isActive) {
    throw new SsoError("本地帳號目前已停用。", "LOCAL_ACCOUNT_DISABLED", 403);
  }
  if (!account.hasRole) {
    throw new SsoError("本地帳號目前沒有可用角色。", "LOCAL_ACCOUNT_UNAUTHORIZED", 403);
  }
  if (!account.authUserId || (!account.authEmail && account.authUserId !== targetAuthUserId)) {
    throw new SsoError("本地帳號尚未綁定有效登入身份。", "LOCAL_ACCOUNT_UNBOUND", 403);
  }

  return { redirectTo: await dependencies.issueTargetSession(account, { targetAuthUserId }) };
}

export async function completeAccountBinding(
  input: SsoRequest,
  account: LocalSsoAccount,
  dependencies: AccountBindingDependencies,
): Promise<{ status: "bound" | "pending_review" }> {
  const flow = validateSsoRequest(input);
  if (flow !== "account_binding") {
    throw new SsoError("一般登入票券不可用於帳號綁定。", "INVALID_SSO_FLOW", 400);
  }
  if (!account.isActive) {
    throw new SsoError("本地帳號目前已停用。", "LOCAL_ACCOUNT_DISABLED", 403);
  }
  if (!account.hasRole) {
    throw new SsoError("本地帳號目前沒有可用角色。", "LOCAL_ACCOUNT_UNAUTHORIZED", 403);
  }

  const localLogin = account.loginName?.trim() || account.authEmail.trim();
  const localEmail = account.localEmail?.trim() || account.authEmail.trim();
  if (!localLogin || !localEmail || !account.authUserId) {
    throw new SsoError("本地帳號缺少可供綁定的登入資料。", "LOCAL_ACCOUNT_UNBOUND", 403);
  }

  const response = await dependencies.callBindingApi({
    ticket: input.ticket,
    systemCode: SSO_SYSTEM_CODE,
    localUserId: account.id,
    localLogin,
    localEmail,
    localEmployeeNo: account.employeeNo ?? null,
    displayName: account.displayName,
    localActive: true,
  });
  if (isRecord(response) && response.ok === true) return { status: "bound" };
  if (isRecord(response) && (response.status === "pending_review" || response.mappingStatus === "pending_review")) {
    return { status: "pending_review" };
  }
  throw new SsoError("帳號綁定尚未完成。", "BINDING_NOT_ACCEPTED", 502);
}

export async function verifyCentralSsoTicket(ticket: string, fetcher: typeof fetch = fetch): Promise<CentralSsoIdentity> {
  let response: Response;
  try {
    response = await fetchWithTimeout(fetcher, CENTRAL_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ ticket, systemCode: SSO_SYSTEM_CODE }),
    });
  } catch {
    throw new SsoError("中央 SSO 驗證服務暫時無法連線。", "CENTRAL_VERIFY_UNAVAILABLE", 502);
  }

  const payload = await readJson(response);
  if (response.status !== 200 || !isRecord(payload) || payload.ok !== true) {
    throw new SsoError("SSO ticket 無效、已過期或已使用。", "INVALID_SSO_TICKET", 401);
  }
  const localUserId = stringValue(payload.localUserId);
  const email = stringValue(payload.email)?.toLowerCase();
  if (!localUserId && !email) {
    throw new SsoError("中央驗證結果缺少本地身份。", "INVALID_SSO_IDENTITY", 403);
  }
  return { ...(localUserId ? { localUserId } : {}), ...(email ? { email } : {}) };
}

export async function callCentralAccountBinding(payload: Record<string, unknown>, fetcher: typeof fetch = fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchWithTimeout(fetcher, CENTRAL_BINDING_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new SsoError("中央帳號綁定服務暫時無法連線。", "CENTRAL_BINDING_UNAVAILABLE", 502);
  }
  const responseBody = await readJson(response);
  if (response.status !== 200) {
    throw new SsoError("中央帳號綁定尚未完成。", "BINDING_NOT_ACCEPTED", 502);
  }
  return responseBody;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function fetchWithTimeout(fetcher: typeof fetch, input: RequestInfo | URL, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    return await fetcher(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  return result ? result : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isAccountBindingPendingCookie(value: string | undefined): boolean {
  return value === "1";
}

export function accountBindingCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 120,
  };
}
