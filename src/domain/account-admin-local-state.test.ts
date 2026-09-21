import { describe, expect, it } from "vitest";
import { applyAccountAdminLocalResult, type AccountAdminLocalState } from "./account-admin-local-state";

const account = {
  id: "account-1",
  auth_user_id: null,
  login_name: "admin01",
  display_name: "管理員",
  email_snapshot: "admin@example.test",
  is_active: true,
};

const initial: AccountAdminLocalState = {
  accounts: [account],
  roleRows: [{ account_id: account.id, role_code: "HR" }],
  scopeRows: [{ account_id: account.id, institution_id: "institution-1", department_id: "department-1" }],
};

describe("account admin local state", () => {
  it("updates a server-verified profile without a directory reload", () => {
    const next = applyAccountAdminLocalResult(initial, {
      operation: "update_profile",
      account: { ...account, login_name: "admin02", display_name: "新管理員" },
    });

    expect(next.accounts[0]).toMatchObject({ login_name: "admin02", display_name: "新管理員" });
    expect(next.roleRows).toEqual(initial.roleRows);
    expect(next.scopeRows).toEqual(initial.scopeRows);
  });

  it("replaces roles and toggles one coordinator scope locally", () => {
    const withRoles = applyAccountAdminLocalResult(initial, {
      operation: "set_roles",
      account,
      roleCodes: ["SYSTEM_ADMIN", "CEO"],
    });
    const withoutScope = applyAccountAdminLocalResult(withRoles, {
      operation: "set_scope",
      account,
      scope: { institutionId: "institution-1", departmentId: "department-1", enabled: false },
    });

    expect(withRoles.roleRows).toEqual([
      { account_id: account.id, role_code: "SYSTEM_ADMIN" },
      { account_id: account.id, role_code: "CEO" },
    ]);
    expect(withoutScope.scopeRows).toEqual([]);
  });
});
