import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadAccountDirectory } from "./account-directory-read";

function queryBuilder(result: unknown) {
  const builder = {
    select: vi.fn(() => builder),
    order: vi.fn(async () => result),
  };
  return builder;
}

function clientFrom(builders: Record<string, ReturnType<typeof queryBuilder>>): SupabaseClient {
  return {
    from: vi.fn((table: string) => builders[table]),
    auth: { refreshSession: vi.fn() },
  } as unknown as SupabaseClient;
}

describe("account directory read adapter", () => {
  it("maps the aggregated view in one read", async () => {
    const view = queryBuilder({
      data: [{
        id: "account-1",
        auth_user_id: "auth-1",
        login_name: "admin01",
        display_name: "管理員",
        email_snapshot: "admin@example.com",
        is_active: true,
        role_codes: ["SYSTEM_ADMIN"],
      }],
      error: null,
    });
    const client = clientFrom({ v_account_directory: view });

    await expect(loadAccountDirectory(client)).resolves.toEqual({
      accounts: [{
        id: "account-1",
        auth_user_id: "auth-1",
        login_name: "admin01",
        display_name: "管理員",
        email_snapshot: "admin@example.com",
        is_active: true,
      }],
      roleRows: [{ account_id: "account-1", role_code: "SYSTEM_ADMIN" }],
      error: null,
      usedLegacyFallback: false,
    });
    expect(client.from).toHaveBeenCalledTimes(1);
    expect(view.select).toHaveBeenCalledWith("id,auth_user_id,login_name,display_name,email_snapshot,is_active,role_codes");
  });

  it("falls back to the existing account and role reads during rollout", async () => {
    const view = queryBuilder({ data: null, error: { code: "PGRST205", message: "Could not find the table" } });
    const accounts = queryBuilder({
      data: [{ id: "account-2", auth_user_id: null, login_name: "hr01", display_name: "人資", email_snapshot: null, is_active: true }],
      error: null,
    });
    const roles = queryBuilder({ data: [{ account_id: "account-2", role_code: "HR" }], error: null });
    const client = clientFrom({ v_account_directory: view, app_accounts: accounts, user_roles: roles });

    await expect(loadAccountDirectory(client)).resolves.toEqual({
      accounts: [{ id: "account-2", auth_user_id: null, login_name: "hr01", display_name: "人資", email_snapshot: null, is_active: true }],
      roleRows: [{ account_id: "account-2", role_code: "HR" }],
      error: null,
      usedLegacyFallback: true,
    });
    expect(client.from).toHaveBeenCalledWith("app_accounts");
    expect(client.from).toHaveBeenCalledWith("user_roles");
  });

  it("does not hide a permission failure behind the rollout fallback", async () => {
    const view = queryBuilder({ data: null, error: { code: "42501", message: "permission denied" } });
    const client = clientFrom({ v_account_directory: view });

    const result = await loadAccountDirectory(client);

    expect(result.error).toMatchObject({ code: "42501" });
    expect(result.usedLegacyFallback).toBe(false);
    expect(client.from).toHaveBeenCalledTimes(1);
  });
});
