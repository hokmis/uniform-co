import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const responseHeaders: HeadersInit = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export async function GET() {
  return NextResponse.json({ ok: true }, { status: 200, headers: responseHeaders });
}
