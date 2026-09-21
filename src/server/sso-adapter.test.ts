import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSsoAdapter, findLocalSsoAccount, issueTargetSupabaseSession } from "./sso-adapter";
import { completeSsoLogin } from "./sso";

const mocks = vi.hoisted(() => ({
  createAuthAdminClient: vi.fn(),
  assertAuthAdminClientMatchesTarget: vi.fn(),
  createServerClient: vi.fn(),
  cookies: vi.fn(),
}));

vi.mock("./account-admin", () => ({
  AccountAdminError: class AccountAdminError extends Error {},
  createAuthAdminClient: mocks.createAuthAdminClient,
  assertAuthAdminClientMatchesTarget: mocks.assertAuthAdminClientMatchesTarget,
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: mocks.createServerClient,
}));

vi.mock("next/headers", () => ({
  cookies: mocks.cookies,
}));

afterEach(() => {
  vi.clearAllMocks();
});

function queryBuilder(result: unknown) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    limit: vi.fn(async () => result),
  };
  return builder;
}

describe("SSO account adapter schema compatibility", () => {
  it("falls back to confirmed app_accounts columns when login_name is not deployed yet", async () => {
    const primary = queryBuilder({
      data: null,
      error: { code: "42703", message: "column app_accounts.login_name does not exist" },
    });
    const fallback = queryBuilder({
      data: [{
        id: "11111111-1111-4111-8111-111111111111",
        auth_user_id: null,
        display_name: "操作人員",
        email_snapshot: "operator@example.com",
        is_active: true,
      }],
      error: null,
    });
    const roles = queryBuilder({ data: [{ role_code: "HR" }], error: null });
    const accountQueries = [primary, fallback];
    const client = {
      from: vi.fn((table: string) => {
        if (table === "app_accounts") return accountQueries.shift();
        return roles;
      }),
    } as unknown as SupabaseClient;
    mocks.createAuthAdminClient.mockReturnValueOnce(client);
    mocks.assertAuthAdminClientMatchesTarget.mockResolvedValueOnce(undefined);

    await expect(findLocalSsoAccount({ localUserId: "11111111-1111-4111-8111-111111111111" })).resolves.toMatchObject({
      id: "11111111-1111-4111-8111-111111111111",
      loginName: null,
      hasRole: true,
    });
    expect(primary.select).toHaveBeenCalledWith("id,auth_user_id,login_name,display_name,email_snapshot,is_active,user_roles(role_code)");
    expect(fallback.select).toHaveBeenCalledWith("id,auth_user_id,display_name,email_snapshot,is_active,user_roles(role_code)");
  });

  it("classifies app_accounts permission failures separately from generic query failures", async () => {
    const accountQuery = queryBuilder({
      data: null,
      error: { code: "42501", message: "permission denied for table app_accounts" },
    });
    const client = {
      from: vi.fn(() => accountQuery),
    } as unknown as SupabaseClient;
    mocks.createAuthAdminClient.mockReturnValueOnce(client);
    mocks.assertAuthAdminClientMatchesTarget.mockResolvedValueOnce(undefined);

    await expect(findLocalSsoAccount({ localUserId: "11111111-1111-4111-8111-111111111111" })).rejects.toMatchObject({
      code: "SSO_CONFIGURATION_ERROR",
      status: 503,
      diagnosticStage: "local_account_permission_denied",
    });
  });

  it("classifies fallback schema failures without exposing the database error", async () => {
    const primary = queryBuilder({
      data: null,
      error: { code: "42703", message: "column app_accounts.login_name does not exist" },
    });
    const fallback = queryBuilder({
      data: null,
      error: { code: "PGRST204", message: "column app_accounts.display_name was not found" },
    });
    const client = {
      from: vi.fn((table: string) => table === "app_accounts" ? [primary, fallback].shift() : undefined),
    } as unknown as SupabaseClient;
    mocks.createAuthAdminClient.mockReturnValueOnce(client);
    mocks.assertAuthAdminClientMatchesTarget.mockResolvedValueOnce(undefined);

    await expect(findLocalSsoAccount({ localUserId: "11111111-1111-4111-8111-111111111111" })).rejects.toMatchObject({
      code: "SSO_CONFIGURATION_ERROR",
      status: 503,
      diagnosticStage: "local_account_schema_mismatch",
    });
  });

  it("classifies user_roles permission failures as a protected data-access error", async () => {
    const accountQuery = queryBuilder({
      data: [{
        id: "11111111-1111-4111-8111-111111111111",
        auth_user_id: null,
        display_name: "操作人員",
        email_snapshot: "operator@example.com",
        is_active: true,
        login_name: "operator01",
      }],
      error: null,
    });
    const roleQuery = queryBuilder({
      data: null,
      error: { code: "42501", message: "permission denied for table user_roles" },
    });
    const client = {
      from: vi.fn((table: string) => table === "app_accounts" ? accountQuery : roleQuery),
    } as unknown as SupabaseClient;
    mocks.createAuthAdminClient.mockReturnValueOnce(client);
    mocks.assertAuthAdminClientMatchesTarget.mockResolvedValueOnce(undefined);

    await expect(findLocalSsoAccount({ localUserId: "11111111-1111-4111-8111-111111111111" })).rejects.toMatchObject({
      code: "SSO_CONFIGURATION_ERROR",
      status: 503,
      diagnosticStage: "local_account_permission_denied",
    });
  });

  it("exchanges the server-generated magic link hash and redirects directly to the verified app", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://target-project.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "target-anon-key");

    const generateLink = vi.fn().mockResolvedValue({
      data: {
        properties: {
          action_link: "https://target-project.supabase.co/auth/v1/verify?token=must-not-be-used",
          hashed_token: "server-only-hash",
        },
        user: { id: "auth-user" },
      },
      error: null,
    });
    const verifyOtp = vi.fn().mockResolvedValue({
      data: { session: { user: { id: "auth-user" } } },
      error: null,
    });
    const adminClient = { auth: { admin: { generateLink } } } as unknown as SupabaseClient;
    const getUser = vi.fn().mockResolvedValue({ data: { user: null }, error: { code: "session_missing" } });
    const sessionClient = { auth: { getUser, verifyOtp } } as unknown as SupabaseClient;
    mocks.createAuthAdminClient.mockReturnValueOnce(adminClient);
    mocks.assertAuthAdminClientMatchesTarget.mockResolvedValueOnce(undefined);
    mocks.cookies.mockResolvedValueOnce({ getAll: vi.fn(() => []), set: vi.fn() });
    mocks.createServerClient.mockReturnValueOnce(sessionClient);

    await expect(issueTargetSupabaseSession({
      id: "local-account",
      authUserId: "auth-user",
      authEmail: "operator@example.com",
      localEmail: "operator@example.com",
      loginName: "operator01",
      displayName: "操作人員",
      isActive: true,
      hasRole: true,
    })).resolves.toBe("https://uniform-co.vercel.app/app");

    expect(generateLink).toHaveBeenCalledWith({ type: "magiclink", email: "operator@example.com" });
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: "server-only-hash", type: "email" });
  });

  it("reuses a matching target session without generating another magic link", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://target-project.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "target-anon-key");

    const generateLink = vi.fn();
    const adminClient = { auth: { admin: { generateLink } } } as unknown as SupabaseClient;
    const getUser = vi.fn().mockResolvedValue({ data: { user: { id: "auth-user" } }, error: null });
    const verifyOtp = vi.fn();
    const sessionClient = { auth: { getUser, verifyOtp } } as unknown as SupabaseClient;
    mocks.createAuthAdminClient.mockReturnValueOnce(adminClient);
    mocks.assertAuthAdminClientMatchesTarget.mockResolvedValueOnce(undefined);
    mocks.cookies.mockResolvedValueOnce({ getAll: vi.fn(() => []), set: vi.fn() });
    mocks.createServerClient.mockReturnValueOnce(sessionClient);

    await expect(issueTargetSupabaseSession({
      id: "local-account",
      authUserId: "auth-user",
      authEmail: "operator@example.com",
      localEmail: "operator@example.com",
      loginName: "operator01",
      displayName: "操作人員",
      isActive: true,
      hasRole: true,
    })).resolves.toBe("https://uniform-co.vercel.app/app");

    expect(generateLink).not.toHaveBeenCalled();
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it("reuses one verified admin client across account and session steps", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://target-project.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "target-anon-key");

    const accountQuery = queryBuilder({
      data: [{
        id: "local-account",
        auth_user_id: "auth-user",
        login_name: "operator01",
        display_name: "操作人員",
        email_snapshot: "operator@example.com",
        is_active: true,
      }],
      error: null,
    });
    const roleQuery = queryBuilder({ data: [{ role_code: "HR" }], error: null });
    const getUserById = vi.fn().mockResolvedValue({ data: { user: { id: "auth-user", email: "operator@example.com" } }, error: null });
    const adminClient = {
      from: vi.fn((table: string) => table === "app_accounts" ? accountQuery : roleQuery),
      auth: { admin: { getUserById, generateLink: vi.fn() } },
    } as unknown as SupabaseClient;
    const sessionClient = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "auth-user" } }, error: null }) },
    } as unknown as SupabaseClient;
    mocks.createAuthAdminClient.mockReturnValueOnce(adminClient);
    mocks.assertAuthAdminClientMatchesTarget.mockResolvedValueOnce(undefined);
    mocks.cookies.mockResolvedValueOnce({ getAll: vi.fn(() => []), set: vi.fn() });
    mocks.createServerClient.mockReturnValueOnce(sessionClient);

    const adapter = createSsoAdapter();
    const account = await adapter.findLocalSsoAccount({ localUserId: "local-account" });
    expect(account).toMatchObject({ id: "local-account", hasRole: true });
    await expect(adapter.issueTargetSupabaseSession(account!)).resolves.toBe("https://uniform-co.vercel.app/app");
    expect(getUserById).toHaveBeenCalledOnce();
    expect(mocks.assertAuthAdminClientMatchesTarget).not.toHaveBeenCalled();
  });

  it("skips the Auth Admin user lookup when the verified target Session already matches", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://target-project.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "target-anon-key");

    const accountQuery = queryBuilder({
      data: [{
        id: "local-account",
        auth_user_id: "auth-user",
        login_name: "operator01",
        display_name: "操作人員",
        email_snapshot: null,
        is_active: true,
      }],
      error: null,
    });
    const roleQuery = queryBuilder({ data: [{ role_code: "HR" }], error: null });
    const getUserById = vi.fn();
    const adminClient = {
      from: vi.fn((table: string) => table === "app_accounts" ? accountQuery : roleQuery),
      auth: { admin: { getUserById, generateLink: vi.fn() } },
    } as unknown as SupabaseClient;
    const sessionGetUser = vi.fn().mockResolvedValue({ data: { user: { id: "auth-user", email: "operator@example.com" } }, error: null });
    const sessionClient = { auth: { getUser: sessionGetUser } } as unknown as SupabaseClient;
    mocks.createAuthAdminClient.mockReturnValueOnce(adminClient);
    mocks.cookies.mockResolvedValueOnce({ getAll: vi.fn(() => []), set: vi.fn() });
    mocks.createServerClient.mockReturnValueOnce(sessionClient);

    const adapter = createSsoAdapter();
    const result = await completeSsoLogin(
      { ticket: "matching-session-ticket", systemCode: "un", flow: "login" },
      {
        verifyTicket: vi.fn(async () => ({ localUserId: "local-account" })),
        getTargetSessionUser: adapter.getTargetSessionUser,
        findAccount: adapter.findLocalSsoAccount,
        issueTargetSession: adapter.issueTargetSupabaseSession,
      },
    );

    expect(result).toEqual({ redirectTo: "https://uniform-co.vercel.app/app" });
    expect(sessionGetUser).toHaveBeenCalledOnce();
    expect(getUserById).not.toHaveBeenCalled();
  });

  it("keeps one Auth Admin user lookup when the target Session belongs to another user", async () => {
    const accountQuery = queryBuilder({
      data: [{
        id: "local-account",
        auth_user_id: "auth-user",
        login_name: "operator01",
        display_name: "操作人員",
        email_snapshot: "operator@example.com",
        is_active: true,
      }],
      error: null,
    });
    const roleQuery = queryBuilder({ data: [{ role_code: "HR" }], error: null });
    const getUserById = vi.fn().mockResolvedValue({ data: { user: { id: "auth-user", email: "operator@example.com" } }, error: null });
    const adminClient = {
      from: vi.fn((table: string) => table === "app_accounts" ? accountQuery : roleQuery),
      auth: { admin: { getUserById } },
    } as unknown as SupabaseClient;
    mocks.createAuthAdminClient.mockReturnValueOnce(adminClient);

    await expect(createSsoAdapter().findLocalSsoAccount(
      { localUserId: "local-account" },
      { targetAuthUserId: "another-auth-user" },
    )).resolves.toMatchObject({ id: "local-account", authEmail: "operator@example.com" });
    expect(getUserById).toHaveBeenCalledOnce();
  });

  it("does not scan Auth users when the local account has no database match", async () => {
    const accountQuery = queryBuilder({ data: [], error: null });
    const listUsers = vi.fn();
    const adminClient = {
      from: vi.fn(() => accountQuery),
      auth: { admin: { listUsers } },
    } as unknown as SupabaseClient;
    mocks.createAuthAdminClient.mockReturnValueOnce(adminClient);

    await expect(findLocalSsoAccount({ email: "missing@example.com" })).resolves.toBeNull();
    expect(listUsers).not.toHaveBeenCalled();
  });

  it("uses embedded roles without a second user_roles query", async () => {
    const accountQuery = queryBuilder({
      data: [{
        id: "local-account",
        auth_user_id: "auth-user",
        login_name: "operator01",
        display_name: "操作人員",
        email_snapshot: "operator@example.com",
        is_active: true,
        user_roles: [{ role_code: "HR" }],
      }],
      error: null,
    });
    const from = vi.fn((table: string) => {
      if (table === "app_accounts") return accountQuery;
      throw new Error("user_roles should be embedded in the account read");
    });
    const adminClient = {
      from,
      auth: { admin: { getUserById: vi.fn().mockResolvedValue({ data: { user: { email: "operator@example.com" } }, error: null }) } },
    } as unknown as SupabaseClient;
    mocks.createAuthAdminClient.mockReturnValueOnce(adminClient);

    await expect(createSsoAdapter().findLocalSsoAccount(
      { localUserId: "local-account" },
      { targetAuthUserId: "auth-user" },
    )).resolves.toMatchObject({ hasRole: true });
    expect(from).toHaveBeenCalledTimes(1);
  });

  it("checks the existing target session before probing admin configuration for account binding", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://target-project.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "target-anon-key");

    const sessionClient = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: { code: "session_missing" } }) },
    } as unknown as SupabaseClient;
    mocks.cookies.mockResolvedValueOnce({ getAll: vi.fn(() => []), set: vi.fn() });
    mocks.createServerClient.mockReturnValueOnce(sessionClient);

    await expect(createSsoAdapter().getCurrentLocalSsoAccount()).rejects.toMatchObject({
      code: "TARGET_SESSION_REQUIRED",
    });
    expect(mocks.createAuthAdminClient).not.toHaveBeenCalled();
  });
});
