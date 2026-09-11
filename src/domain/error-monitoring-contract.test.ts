import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createServerErrorRecord, reportServerError } from "../server/error-monitoring";

const root = process.cwd();

const context = {
  routerKind: "App Router" as const,
  routePath: "/api/admin/accounts?token=SENTINEL_QUERY#fragment",
  routeType: "route" as const,
  revalidateReason: undefined,
};

describe("error monitoring contract", () => {
  it("logs only allowlisted metadata and never raw error or query details", () => {
    const error = new TypeError("SENTINEL_MESSAGE");
    error.stack = "SENTINEL_STACK https://user:pass@db.invalid/db?token=SENTINEL_TOKEN";
    (error as Error & { digest?: string }).digest = "safe-digest_123";
    const lines: string[] = [];

    const record = reportServerError(
      { error, context },
      {
        environment: "staging",
        now: () => new Date("2026-08-29T10:00:00.000Z"),
        logger: (line) => lines.push(line),
      },
    );

    expect(Object.keys(record).sort()).toEqual(
      [
        "digest",
        "environment",
        "errorKind",
        "event",
        "fingerprint",
        "routePath",
        "routeType",
        "routerKind",
        "timestamp",
        "version",
      ].sort(),
    );
    expect(record).toMatchObject({
      event: "server.request_error",
      version: 1,
      environment: "staging",
      routePath: "/api/admin/accounts",
      errorKind: "TypeError",
      digest: "safe-digest_123",
    });

    const output = lines.join("\n");
    expect(output).toContain("[error-monitoring]");
    expect(output).not.toContain("SENTINEL_MESSAGE");
    expect(output).not.toContain("SENTINEL_STACK");
    expect(output).not.toContain("SENTINEL_QUERY");
    expect(output).not.toContain("SENTINEL_TOKEN");
    expect(output).not.toContain("user:pass");
  });

  it("keeps fingerprints deterministic while separating route and error kind", () => {
    const options = { environment: "production", now: () => new Date("2026-08-29T10:00:00.000Z") };
    const first = createServerErrorRecord({ error: new TypeError("first"), context }, options);
    const same = createServerErrorRecord({ error: new TypeError("different message"), context }, options);
    const otherRoute = createServerErrorRecord(
      { error: new TypeError("first"), context: { ...context, routePath: "/api/other" } },
      options,
    );
    const otherKind = createServerErrorRecord({ error: new RangeError("first"), context }, options);

    expect(first.fingerprint).toBe(same.fingerprint);
    expect(first.fingerprint).not.toBe(otherRoute.fingerprint);
    expect(first.fingerprint).not.toBe(otherKind.fingerprint);
  });

  it("wires the Next.js hook and client boundary without exposing raw errors", async () => {
    const [instrumentation, boundary] = await Promise.all([
      readFile(join(root, "instrumentation.ts"), "utf8"),
      readFile(join(root, "src", "app", "error.tsx"), "utf8"),
    ]);

    expect(instrumentation).toContain("reportServerError({ error, context })");
    expect(instrumentation).not.toContain("console.error");
    expect(boundary).toContain("onClick={reset}");
    expect(boundary).not.toMatch(/error\.(message|stack)/);
    expect(boundary).not.toContain("console.error");
  });
});
