import { describe, expect, it } from "vitest";
import {
  accountLabelFromUser,
  authEmailForAccountLogin,
  authEmailForLoginIdentifier,
  normalizeAccountLogin,
} from "./account-login";

describe("account login adapter", () => {
  it("normalizes supported login names", () => {
    expect(normalizeAccountLogin("  HRUser01 ")).toBe("hruser01");
    expect(normalizeAccountLogin("ab")).toBe("ab");
    expect(normalizeAccountLogin("a")).toBeNull();
    expect(normalizeAccountLogin("hr.user")).toBeNull();
    expect(normalizeAccountLogin("hr_user")).toBeNull();
    expect(normalizeAccountLogin("hr-user")).toBeNull();
    expect(normalizeAccountLogin("user@example.com")).toBeNull();
  });

  it("maps a login name to a non-deliverable internal Auth email", () => {
    expect(authEmailForAccountLogin("warehouse01")).toBe("warehouse01@auth.uniform-co.invalid");
  });

  it("keeps legacy email login compatible", () => {
    expect(authEmailForLoginIdentifier(" Admin@Example.com ")).toBe("admin@example.com");
    expect(authEmailForLoginIdentifier("procurement01")).toBe("procurement01@auth.uniform-co.invalid");
  });

  it("prefers the business display name in the signed-in UI", () => {
    expect(accountLabelFromUser({ email: "internal@example.com", user_metadata: { display_name: "王小明", login_name: "hr01" } })).toBe("王小明");
  });
});
