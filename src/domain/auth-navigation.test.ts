import { describe, expect, it } from "vitest";
import { PUBLIC_LOGIN_ENTRY, resolvePostLogoutEntry } from "./auth-navigation";

describe("authentication navigation", () => {
  it("returns to the login entry after a successful logout", () => {
    expect(resolvePostLogoutEntry()).toBe(PUBLIC_LOGIN_ENTRY);
    expect(resolvePostLogoutEntry()).toBe("/login");
  });
});
