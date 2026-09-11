import { describe, expect, it } from "vitest";
import { validateAccountCreation } from "./account-admin-form";

describe("account creation form", () => {
  it("explains every condition that previously left the create button inert", () => {
    expect(validateAccountCreation({
      loginName: "",
      password: "short",
      roleCount: 0,
      reason: "",
    })).toEqual([
      "請填寫登入帳號。",
      "初始密碼至少需要 6 個字元。",
      "請至少選擇一個角色權限。",
      "請填寫建立理由。",
    ]);
  });

  it("allows a complete account request", () => {
    expect(validateAccountCreation({
      loginName: "hr01",
      password: "a-secure-pass",
      roleCount: 1,
      reason: "建立人資帳號",
    })).toEqual([]);
  });

  it("accepts the six-character minimum", () => {
    expect(validateAccountCreation({
      loginName: "hr01",
      password: "123456",
      roleCount: 1,
      reason: "建立人資帳號",
    })).toEqual([]);
  });
});
