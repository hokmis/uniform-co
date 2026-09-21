import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(process.cwd(), "src/app/use-auth-session.ts"), "utf8");

describe("auth session subscription", () => {
  it("uses the auth-state stream as the single source for initial and subsequent sessions", () => {
    expect(source).toContain("client.auth.onAuthStateChange");
    expect(source).toContain("setSession(session ?? null)");
    expect(source).toContain("setUser(session?.user ?? null)");
    expect(source).toContain("setLoading(false)");
    expect(source).not.toContain("client.auth.getSession()");
  });

  it("keeps pending account binding resume attached to authenticated session events", () => {
    expect(source).toContain("if (session) void resumePendingBinding();");
    expect(source).toContain("data.subscription.unsubscribe()");
  });
});
