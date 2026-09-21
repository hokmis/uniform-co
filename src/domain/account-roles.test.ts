import { describe, expect, it } from "vitest";
import { ACCOUNT_ROLE_CODES, accountHasEffectiveRole, effectiveAccountRoles } from "./account-roles";

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
});
