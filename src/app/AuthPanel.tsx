"use client";

import { useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { authEmailForLoginIdentifier } from "@/src/lib/account-login";
import { resolveLocalLoginResult } from "@/src/domain/local-login";

let browserAuthClientPromise: Promise<SupabaseClient | null> | null = null;

function hasPublicSupabaseConfig(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

function loadBrowserAuthClient(): Promise<SupabaseClient | null> {
  if (!browserAuthClientPromise) {
    browserAuthClientPromise = import("@/src/lib/supabase-browser")
      .then(({ getSupabaseBrowserClient }) => getSupabaseBrowserClient())
      .catch((error: unknown) => {
        browserAuthClientPromise = null;
        throw error;
      });
  }
  return browserAuthClientPromise;
}

function prefetchBrowserAuthClient(): void {
  if (!hasPublicSupabaseConfig()) return;
  void loadBrowserAuthClient().catch(() => undefined);
}

export default function AuthPanel() {
  const [loginIdentifier, setLoginIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  if (!hasPublicSupabaseConfig()) {
    return (
      <section className="auth-panel panel" aria-label="登入設定" data-auth-state="configuration-required">
        <div>
          <p className="eyebrow">ACCOUNT / CONFIGURATION REQUIRED</p>
          <h2>尚未連接登入服務</h2>
          <p className="auth-message">
            尚未設定 Supabase URL 與 anon key；正式工作區已鎖定，請先在 Vercel Environment Variables 設定部署環境，再用受邀帳號登入。
          </p>
        </div>
        <span className="status-pill">未連接 Supabase</span>
      </section>
    );
  }
  async function signIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const authEmail = authEmailForLoginIdentifier(loginIdentifier);
    if (!authEmail) {
      setMessage("登入帳號格式不正確；請輸入至少 3 個英數字，或使用既有 Email 帳號登入。");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const supabase = await loadBrowserAuthClient();
      if (!supabase) {
        setMessage("登入服務目前無法使用，請重新整理後再試。");
        return;
      }
      const { error } = await supabase.auth.signInWithPassword({ email: authEmail, password });
      const result = resolveLocalLoginResult(error);
      setMessage(result.message);
      if (result.ok) {
        // This panel is also rendered directly inside the same-origin SSO
        // choice dialog. That path does not mount WorkspaceShell's session
        // listener, so explicitly enter the server-guarded work entry after a
        // successful local login. A pending account-binding cookie is then
        // resumed by the normal /app session bootstrap.
        window.location.replace(result.redirectTo);
      }
    } catch {
      setMessage("登入服務暫時無法使用，請稍後再試。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="auth-panel panel" aria-label="帳號登入" data-auth-state="signed-out">
      <div>
        <p className="eyebrow">ACCOUNT / INVITED USERS</p>
        <h2>登入後使用正式資料</h2>
        <p className="auth-message">請使用管理員建立的登入帳號與密碼。既有使用者仍可暫時使用原本的 Email 登入；角色與需求窗口範圍由系統權限控制。</p>
      </div>
      <form className="auth-form" onSubmit={signIn}>
        <label className="field">
          <span>登入帳號</span>
          <input autoComplete="username" value={loginIdentifier} onFocus={prefetchBrowserAuthClient} onChange={(event) => setLoginIdentifier(event.target.value)} required />
        </label>
        <label className="field">
          <span>密碼</span>
          <input autoComplete="current-password" type="password" value={password} onFocus={prefetchBrowserAuthClient} onChange={(event) => setPassword(event.target.value)} required />
        </label>
        <button className="primary-button" type="submit" disabled={busy}>
          {busy ? "處理中…" : "登入"}
        </button>
        {message ? <p className="auth-message" role="status">{message}</p> : null}
      </form>
    </section>
  );
}
