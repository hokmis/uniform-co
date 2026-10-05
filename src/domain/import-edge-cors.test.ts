import { describe, expect, it } from "vitest";
import { importCorsHeaders, isAllowedImportOrigin } from "./import-edge-cors";

describe("import Edge CORS", () => {
  const configured = "https://uniform-co.vercel.app, https://uniform.hok.tw/";
  it.each(["https://uniform-co.vercel.app", "https://uniform.hok.tw"])("allows the exact configured origin %s", (origin) => {
    expect(isAllowedImportOrigin(origin, configured)).toBe(true);
    const headers = importCorsHeaders(origin, configured);
    expect(headers.get("access-control-allow-origin")).toBe(origin);
    expect(headers.get("vary")).toBe("Origin");
    for (const name of ["authorization", "apikey", "x-client-info", "content-type"]) {
      expect(headers.get("access-control-allow-headers")?.split(",").map((entry) => entry.trim())).toContain(name);
    }
  });
  it.each(["https://uniform-co.vercel.app.evil.test", "http://uniform-co.vercel.app", "null", "https://evil.test"])("rejects unconfigured origin %s", (origin) => {
    expect(isAllowedImportOrigin(origin, configured)).toBe(false);
    expect(importCorsHeaders(origin, configured).has("access-control-allow-origin")).toBe(false);
  });
  it("does not turn malformed configuration into wildcard or path-based access", () => {
    expect(isAllowedImportOrigin("https://uniform.hok.tw", "*,https://uniform.hok.tw/private")).toBe(false);
    expect(isAllowedImportOrigin("https://uniform.hok.tw", "")).toBe(false);
    expect(importCorsHeaders(null, configured).has("access-control-allow-origin")).toBe(false);
  });
});
