"use client";

import { useEffect, useState } from "react";
import { inspectAuthCallbackUrl, scrubAuthCallbackUrl } from "@/src/domain/auth-callback";
import { getSupabaseMagicLinkBrowserClient } from "@/src/lib/supabase-magic-link-browser";

export default function AuthCallbackPage() {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    const clearCallbackUrl = () => {
      const cleanUrl = scrubAuthCallbackUrl(window.location.href);
      if (cleanUrl !== window.location.href) {
        window.history.replaceState(window.history.state, "", cleanUrl);
      }
    };

    const callbackState = inspectAuthCallbackUrl(window.location.href);
    if (!callbackState.canUseImplicitClient) {
      clearCallbackUrl();
      queueMicrotask(() => {
        if (active) setFailed(true);
      });
      return () => {
        active = false;
      };
    }

    const client = getSupabaseMagicLinkBrowserClient();
    if (!client) {
      clearCallbackUrl();
      window.location.replace("/login?error=sso");
      return;
    }

    void client.auth.getSession().then(({ data: sessionData, error }) => {
      clearCallbackUrl();
      if (!active) return;
      if (!error && sessionData.session) {
        window.location.replace("/app");
      } else {
        setFailed(true);
      }
    }).catch(() => {
      clearCallbackUrl();
      if (active) setFailed(true);
    });

    return () => {
      active = false;
    };
  }, []);

  if (failed) {
    return (
      <main className="auth-landing">
        <section className="auth-panel panel" aria-live="polite">
          <p className="eyebrow">SSO / SESSION</p>
          <h1>登入連結已失效</h1>
          <p className="auth-message">請回到登入頁重新開始，不要重複使用同一個連結。</p>
          <a className="primary-button" href="/login">返回登入</a>
        </section>
      </main>
    );
  }

  return (
    <main className="auth-landing">
      <section className="auth-panel panel" aria-live="polite">
        <p className="eyebrow">SSO / SESSION</p>
        <h1>正在建立已驗證工作階段</h1>
        <p className="auth-message">驗證完成後將進入制服資產作業台。</p>
      </section>
    </main>
  );
}
