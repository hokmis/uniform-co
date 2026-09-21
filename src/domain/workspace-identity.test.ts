import { describe, expect, it } from "vitest";
import { workspaceIdentityForUser, type WorkspaceIdentitySnapshot } from "./workspace-identity";

describe("workspace identity snapshot", () => {
  const accountA: WorkspaceIdentitySnapshot = {
    userId: "auth-user-a",
    accountId: "account-a",
    roles: ["SYSTEM_ADMIN"],
    loading: false,
    error: null,
  };

  it("keeps a snapshot only for the Auth user that produced it", () => {
    expect(workspaceIdentityForUser(accountA, "auth-user-a", true)).toBe(accountA);
  });

  it("hides the prior account and roles while a different user identity loads", () => {
    expect(workspaceIdentityForUser(accountA, "auth-user-b", true)).toEqual({
      userId: "auth-user-b",
      accountId: null,
      roles: [],
      loading: true,
      error: null,
    });
  });

  it("clears the old account immediately on sign-out", () => {
    expect(workspaceIdentityForUser(accountA, null, false)).toEqual({
      userId: null,
      accountId: null,
      roles: [],
      loading: false,
      error: null,
    });
  });
});
