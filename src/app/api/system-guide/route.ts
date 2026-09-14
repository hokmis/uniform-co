import { NextResponse } from "next/server";
import {
  AccountAdminError,
  authorizeSystemAdmin,
  createCallerClient,
} from "@/src/server/account-admin";
import { loadSystemGuideDocuments } from "@/src/server/system-guide";

export const dynamic = "force-dynamic";

const responseHeaders: HeadersInit = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  const host = request.headers.get("host");
  try {
    return host !== null && new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function authorize(request: Request): Promise<void> {
  if (!sameOrigin(request)) throw new AccountAdminError("請求來源不被允許。", 403);
  const client = createCallerClient(request.headers.get("authorization"));
  await authorizeSystemAdmin(client);
}

function errorResponse(error: unknown): NextResponse {
  if (error instanceof AccountAdminError) {
    const message = error.status === 401
      ? "登入工作階段不存在或已過期。"
      : error.status === 403
        ? "需要 SYSTEM_ADMIN 權限才能查看系統說明。"
        : "系統說明目前無法讀取。";
    return NextResponse.json({ ok: false, error: message }, { status: error.status, headers: responseHeaders });
  }
  return NextResponse.json({ ok: false, error: "系統說明目前無法讀取。" }, { status: 500, headers: responseHeaders });
}

export async function HEAD(request: Request) {
  try {
    await authorize(request);
    return new NextResponse(null, { status: 204, headers: responseHeaders });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET(request: Request) {
  try {
    await authorize(request);
    const documents = await loadSystemGuideDocuments();
    return NextResponse.json({ ok: true, documents }, { headers: responseHeaders });
  } catch (error) {
    return errorResponse(error);
  }
}
