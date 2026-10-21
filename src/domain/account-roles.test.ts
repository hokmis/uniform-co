import { describe, expect, it } from "vitest";
import { ACCOUNT_ROLE_CODES, accountHasEffectiveRole, effectiveAccountRoles, resolveAllowedWorkspaces } from "./account-roles";

describe("account role capabilities", () => {
  it("expands SYSTEM_ADMIN to every effective role without changing stored rows", () => {
    expect(effectiveAccountRoles(["SYSTEM_ADMIN"])).toEqual([...ACCOUNT_ROLE_CODES]);
    expect(effectiveAccountRoles(["SYSTEM_ADMIN", "HR"])).toEqual([...ACCOUNT_ROLE_CODES]);
  });

  it("keeps ordinary accounts limited to their assigned roles", () => {
    expect(effectiveAccountRoles(["HR", "CEO"])).toEqual(["HR", "CEO"]);
    expect(accountHasEffectiveRole(["HR"], "HR")).toBe(true);
    expect(accountHasEffectiveRole(["HR"], "WAREHOUSE")).toBe(false);
  });

  it("resolves workspaces correctly based on assigned roles", () => {
    expect(resolveAllowedWorkspaces(["SYSTEM_ADMIN"])).toEqual([
      "overview",
      "accounts",
      "hr",
      "warehouse",
      "procurement",
      "seasonal",
      "reports",
    ]);

    expect(resolveAllowedWorkspaces(["HR"])).toEqual(["overview", "hr", "reports"]);
    expect(resolveAllowedWorkspaces(["WAREHOUSE"])).toEqual(["overview", "warehouse", "reports"]);
    expect(resolveAllowedWorkspaces(["HR", "WAREHOUSE"])).toEqual(["overview", "hr", "warehouse", "reports"]);
    expect(resolveAllowedWorkspaces(["DEMAND_COORDINATOR"])).toEqual(["hr", "seasonal"]);
    expect(resolveAllowedWorkspaces([])).toEqual([]);
  });
});

