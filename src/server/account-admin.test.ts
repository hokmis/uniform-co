import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AccountAdminError,
  assertAuthAdminClientMatchesTarget,
  createAuthAdminClient,
  sameAccountProfile,
  sameRoleSet,
  type AccountRecord,
} from "./account-admin";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Supabase Auth admin configuration", () => {
  it("rejects using the public anon key as the server admin key", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://target-project.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "same-key");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "same-key");

    expect(() => createAuthAdminClient()).toThrowError(AccountAdminError);
    try {
      createAuthAdminClient();
    } catch (error) {
      expect(error).toMatchObject({
        status: 503,
        diagnosticStage: "supabase_admin_key_invalid",
      });
    }
  });

  it("rejects a legacy service-role JWT from a different Supabase project", () => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ role: "service_role", ref: "central-project" })).toString("base64url");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://target-project.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", `${header}.${payload}.signature`);

    expect(() => createAuthAdminClient()).toThrowError(AccountAdminError);
    try {
      createAuthAdminClient();
    } catch (error) {
      expect(error).toMatchObject({
        status: 503,
        diagnosticStage: "supabase_admin_project_mismatch",
      });
    }
  });

  it("requires the server admin API to answer from the target project", async () => {
    const client = {
      auth: {
        admin: {
          listUsers: vi.fn(async () => ({ data: { users: [] }, error: { message: "unauthorized" } })),
        },
      },
    } as never;

    await expect(assertAuthAdminClientMatchesTarget(client)).rejects.toMatchObject({
      status: 503,
      diagnosticStage: "supabase_admin_project_mismatch",
    });
  });
});

describe("account administration persistence checks", () => {
  const account: AccountRecord = {
    id: "11111111-1111-4111-8111-111111111111",
    auth_user_id: null,
    login_name: "admin01",
    display_name: "管理員",
    email_snapshot: "admin@example.test",
    is_active: true,
  };

  it("rejects a stale profile result instead of reporting a successful save", async () => {
    const operation = {
      operation: "update_profile" as const,
      account_id: account.id,
      login_name: "admin02",
      display_name: "新管理員",
      email: "new-admin@example.test",
      reason: "更新測試",
      idempotency_key: "profile-test",
    };
    expect(sameAccountProfile(account, operation)).toBe(false);
    expect(sameAccountProfile({ ...account, login_name: "admin02", display_name: "新管理員", email_snapshot: "new-admin@example.test" }, operation)).toBe(true);
  });

  it("verifies a role replacement as a set, independent of row order", () => {
    expect(sameRoleSet(["HR", "SYSTEM_ADMIN"], ["SYSTEM_ADMIN", "HR"])).toBe(true);
    expect(sameRoleSet(["HR"], ["HR", "CEO"])).toBe(false);
  });
});
