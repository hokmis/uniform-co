import { NextResponse } from "next/server";
import {
  AccountAdminError,
  createAuthAdminClient,
  createCallerClient,
  authorizeSystemAdmin,
  executeAccountAdminOperation,
  type AccountAdminOperation,
} from "@/src/server/account-admin";

export const dynamic = "force-dynamic";

function responseHeaders(): HeadersInit {
  return { "Cache-Control": "private, no-store" };
}

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

function errorResponse(error: unknown): NextResponse {
  if (error instanceof AccountAdminError) {
    return NextResponse.json({ ok: false, error: error.message }, { status: error.status, headers: responseHeaders() });
  }
  return NextResponse.json({ ok: false, error: "帳號管理操作失敗，請稍後重試。" }, { status: 500, headers: responseHeaders() });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ ok: false, error: "請求來源不被允許。" }, { status: 403, headers: responseHeaders() });
  }

  try {
    const body = await request.json() as { operation?: unknown } & Record<string, unknown>;
    if (typeof body.operation !== "string") {
      throw new AccountAdminError("帳號管理操作不正確。", 400);
    }
    const client = createCallerClient(request.headers.get("authorization"));
    const actor = await authorizeSystemAdmin(client);
    const needsAuthAdmin = ["create", "update_profile", "set_password", "set_status", "delete"].includes(body.operation);
    const authAdminClient = needsAuthAdmin ? createAuthAdminClient() : null;
    const result = await executeAccountAdminOperation(client, authAdminClient, actor, body as unknown as AccountAdminOperation);
    return NextResponse.json({ ok: true, ...result }, { headers: responseHeaders() });
  } catch (error) {
    return errorResponse(error);
  }
}
