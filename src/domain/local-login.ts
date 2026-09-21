export const LOCAL_LOGIN_REDIRECT = "/app" as const;

export type LocalLoginResult =
  | { ok: true; message: string; redirectTo: typeof LOCAL_LOGIN_REDIRECT }
  | { ok: false; message: string };

export function resolveLocalLoginResult(error: unknown): LocalLoginResult {
  if (error) {
    return { ok: false, message: "帳號或密碼不正確。" };
  }

  return {
    ok: true,
    message: "登入成功，正在進入制服資產作業台。",
    redirectTo: LOCAL_LOGIN_REDIRECT,
  };
}
