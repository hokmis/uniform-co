import { NextResponse } from "next/server";
import {
  SSO_BINDING_PENDING_COOKIE,
  SSO_BINDING_TICKET_COOKIE,
  SSO_LOGIN_PENDING_COOKIE,
  SSO_LOGIN_TICKET_COOKIE,
  SSO_TARGET_ORIGIN,
  SsoError,
  accountBindingCookieOptions,
  callCentralAccountBinding,
  completeAccountBinding,
  completeSsoLogin,
  defaultSsoDiagnosticStage,
  isSsoDiagnosticStage,
  isSsoError,
  normalizeSsoFlow,
  verifyCentralSsoTicket,
  type SsoRequest,
} from "../../../server/sso";
import {
  createSsoAdapter,
  type SsoAdapter,
} from "../../../server/sso-adapter";

export const dynamic = "force-dynamic";

const responseHeaders: HeadersInit = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

type BodyRecord = Record<string, unknown>;
type SsoCallbackInput = SsoRequest & {
  resume: boolean;
  confirm: boolean;
  cancel: boolean;
  localFallback: boolean;
};

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}

async function handle(request: Request): Promise<NextResponse> {
  try {
    const input = await readInput(request);
    const flow = normalizeSsoFlow(input.flow);
    if (!flow) throw new SsoError("不支援的 SSO flow。", "INVALID_SSO_FLOW", 400);
    if (input.systemCode !== "un") throw new SsoError("SSO system code 不正確。", "INVALID_SYSTEM_CODE", 400);

    if (flow === "account_binding") {
      const adapter = createSsoAdapter();
      return await handleAccountBinding(input, adapter);
    }

    if (input.cancel) return cancelSsoLogin(input.localFallback);
    if (!input.confirm) return startSsoLogin(input);

    const adapter = createSsoAdapter();
    const result = await completeConfirmedSsoLogin(input, adapter);
    const response = navigationResponse(request, result.redirectTo);
    response.cookies.delete(SSO_LOGIN_TICKET_COOKIE);
    response.cookies.delete(SSO_LOGIN_PENDING_COOKIE);
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}

async function completeConfirmedSsoLogin(input: SsoCallbackInput, adapter: SsoAdapter) {
  const { cookies } = await import("next/headers");
  const cookieStore = await cookies();
  const pendingTicket = cookieStore.get(SSO_LOGIN_TICKET_COOKIE)?.value ?? null;
  if (!pendingTicket) {
    throw new SsoError(
      "SSO pending state 不存在或已失效。",
      "SSO_PENDING_STATE_MISSING",
      400,
      "sso_pending_state_missing",
    );
  }

  return completeSsoLogin({ ...input, ticket: pendingTicket }, {
    verifyTicket: verifyCentralSsoTicket,
    getTargetSessionUser: adapter.getTargetSessionUser,
    findAccount: adapter.findLocalSsoAccount,
    issueTargetSession: adapter.issueTargetSupabaseSession,
  });
}

function startSsoLogin(input: SsoCallbackInput): NextResponse {
  if (!input.ticket) throw new SsoError("SSO ticket 不存在或格式不正確。", "MISSING_SSO_TICKET", 400);

  const response = redirectResponse(`${SSO_TARGET_ORIGIN}/login?sso_pending=1`);
  const options = accountBindingCookieOptions();
  response.cookies.set(SSO_LOGIN_TICKET_COOKIE, input.ticket, options);
  response.cookies.set(SSO_LOGIN_PENDING_COOKIE, "1", options);
  return response;
}

function cancelSsoLogin(localFallback: boolean): NextResponse {
  const response = redirectResponse(`${SSO_TARGET_ORIGIN}/login${localFallback ? "?sso_local=1" : ""}`);
  response.cookies.delete(SSO_LOGIN_TICKET_COOKIE);
  response.cookies.delete(SSO_LOGIN_PENDING_COOKIE);
  return response;
}

async function handleAccountBinding(input: SsoRequest & { resume: boolean }, adapter: SsoAdapter): Promise<NextResponse> {
  const { cookies } = await import("next/headers");
  const cookieStore = await cookies();
  const pendingTicket = input.ticket ?? (input.resume ? cookieStore.get(SSO_BINDING_TICKET_COOKIE)?.value ?? null : null);
  if (!pendingTicket) throw new SsoError("SSO ticket 不存在或格式不正確。", "MISSING_SSO_TICKET", 400);

  try {
    const account = await adapter.getCurrentLocalSsoAccount();
    const result = await completeAccountBinding(
      { ...input, ticket: pendingTicket },
      account,
      { callBindingApi: callCentralAccountBinding },
    );
    const target = new URL("/app", SSO_TARGET_ORIGIN);
    target.searchParams.set("sso_binding", result.status);
    const response = redirectResponse(target.toString());
    response.cookies.delete(SSO_BINDING_TICKET_COOKIE);
    response.cookies.delete(SSO_BINDING_PENDING_COOKIE);
    return response;
  } catch (error) {
    if (isSsoError(error) && error.code === "TARGET_SESSION_REQUIRED" && input.ticket) {
      const response = redirectResponse(`${SSO_TARGET_ORIGIN}/login`);
      const options = accountBindingCookieOptions();
      response.cookies.set(SSO_BINDING_TICKET_COOKIE, pendingTicket, options);
      response.cookies.set(SSO_BINDING_PENDING_COOKIE, "1", { ...options, httpOnly: false });
      return response;
    }
    throw error;
  }
}

async function readInput(request: Request): Promise<SsoCallbackInput> {
  const url = new URL(request.url);
  let body: BodyRecord = {};
  if (request.method === "POST") {
    const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
    try {
      if (contentType.includes("application/json")) {
        const parsed = await request.json();
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as BodyRecord;
      } else if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
        const formData = await request.formData();
        for (const [key, value] of formData.entries()) {
          if (typeof value === "string") body[key] = value;
        }
      }
    } catch {
      throw new SsoError("SSO callback 請求格式不正確。", "INVALID_SSO_REQUEST", 400);
    }
  }

  const value = (key: string): string | null => {
    const queryValue = url.searchParams.get(key);
    if (queryValue !== null) return queryValue.trim() || null;
    const bodyValue = body[key];
    return typeof bodyValue === "string" ? bodyValue.trim() || null : null;
  };
  const resume = body.resume === true || body.resume === "true" || url.searchParams.get("resume") === "1";
  const confirm = body.confirm === true || body.confirm === "true" || url.searchParams.get("confirm") === "1";
  const cancel = body.cancel === true || body.cancel === "true" || url.searchParams.get("cancel") === "1";
  const localFallback = body.local === true || body.local === "true" || url.searchParams.get("local") === "1";
  return {
    ticket: value("sso_ticket"),
    systemCode: value("system_code"),
    flow: value("sso_flow"),
    resume,
    confirm,
    cancel,
    localFallback,
  };
}

function redirectResponse(location: string): NextResponse {
  return new NextResponse(null, {
    status: 303,
    headers: { ...responseHeaders, Location: location },
  });
}

function navigationResponse(request: Request, location: string): NextResponse {
  if (request.headers.get("accept")?.toLowerCase().includes("application/json")) {
    return NextResponse.json({ ok: true, redirectTo: location }, {
      status: 200,
      headers: responseHeaders,
    });
  }
  return redirectResponse(location);
}

function errorResponse(error: unknown): NextResponse {
  if (isSsoError(error)) {
    const messages: Record<string, string> = {
      SSO_CONFIGURATION_ERROR: "SSO 設定尚未完成，請聯絡系統管理員。",
      TARGET_SESSION_REQUIRED: "請先使用目標系統原有登入方式登入，再完成帳號綁定。",
      INVALID_SSO_TICKET: "SSO ticket 無效、已過期或已使用。",
      MISSING_SSO_TICKET: "SSO ticket 不存在或格式不正確。",
      SSO_PENDING_STATE_MISSING: "SSO 登入狀態不存在或已失效，請重新從中央 Portal 開始。",
      LOCAL_ACCOUNT_NOT_FOUND: "找不到可用的本地帳號。",
      LOCAL_ACCOUNT_DISABLED: "本地帳號目前已停用。",
      LOCAL_ACCOUNT_UNBOUND: "本地帳號尚未綁定有效登入身份。",
      LOCAL_ACCOUNT_UNAUTHORIZED: "本地帳號目前沒有可用角色。",
      AMBIGUOUS_LOCAL_ACCOUNT: "本地帳號對應不唯一。",
      INVALID_SSO_FLOW: "不支援的 SSO flow。",
      INVALID_SYSTEM_CODE: "SSO system code 不正確。",
    };
    const diagnosticStage = isSsoDiagnosticStage(error.diagnosticStage)
      ? error.diagnosticStage
      : defaultSsoDiagnosticStage(error.code);
    return NextResponse.json({
      ok: false,
      code: error.code,
      error: messages[error.code] ?? "SSO 操作未完成。",
      diagnosticStage,
    }, {
      status: error.status,
      headers: responseHeaders,
    });
  }
  return NextResponse.json({
    ok: false,
    code: "SSO_ERROR",
    error: "SSO 操作未完成，請稍後重試。",
    diagnosticStage: "sso_callback_failed",
  }, {
    status: 500,
    headers: responseHeaders,
  });
}
