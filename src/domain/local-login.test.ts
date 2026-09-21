import { describe, expect, it } from "vitest";
import { LOCAL_LOGIN_REDIRECT, resolveLocalLoginResult } from "./local-login";

describe("local password login", () => {
  it("moves a successful local login to the authenticated work entry", () => {
    expect(resolveLocalLoginResult(null)).toEqual({
      ok: true,
      message: "登入成功，正在進入制服資產作業台。",
      redirectTo: LOCAL_LOGIN_REDIRECT,
    });
  });

  it("keeps authentication failures generic and does not provide a redirect", () => {
    expect(resolveLocalLoginResult(new Error("raw Supabase error must not reach the UI"))).toEqual({
      ok: false,
      message: "帳號或密碼不正確。",
    });
  });
});
