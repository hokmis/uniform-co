"use client";

import { useState } from "react";
import AuthPanel from "./AuthPanel";
import { CENTRAL_PORTAL_URL } from "@/src/domain/sso-entry";

const SAFE_SSO_DIAGNOSTIC_STAGES = new Set([
  "invalid_request",
  "invalid_system_code",
  "invalid_flow",
  "ticket_missing",
  "ticket_rejected",
  "target_session_missing",
  "sso_pending_state_missing",
  "supabase_runtime_config_missing",
  "supabase_target_url_invalid",
  "supabase_admin_key_invalid",
  "supabase_admin_project_mismatch",
  "local_account_permission_denied",
  "local_account_schema_mismatch",
  "local_account_query_failed",
  "local_account_missing",
  "local_account_not_unique",
  "local_account_disabled",
  "local_account_unbound",
  "local_account_unauthorized",
  "local_role_query_failed",
  "local_auth_user_query_failed",
  "target_session_create_failed",
  "central_verify_failed",
  "central_binding_failed",
  "sso_configuration_failed",
  "sso_callback_failed",
  "sso_response_invalid",
  "sso_client_request_failed",
  "sso_redirect_invalid",
]);

type PromptState = "choice" | "confirm" | "processing" | "complete" | "failed" | "canceling";

type SsoLoginPromptProps = {
  mode?: "direct" | "pending";
  initialDiagnosticStage?: string;
};

function safeDiagnosticStage(payload: unknown): string {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return "sso_response_invalid";
  const value = (payload as { diagnosticStage?: unknown }).diagnosticStage;
  return typeof value === "string" && SAFE_SSO_DIAGNOSTIC_STAGES.has(value)
    ? value
    : "sso_response_invalid";
}

function stateTitle(state: PromptState): string {
  if (state === "complete") return "SSO登入完成";
  if (state === "failed") return "SSO登入失敗";
  if (state === "choice") return "選擇登入方式";
  return "SSO帳號登入中";
}

function navigateToAuthenticatedEntry(location: string): boolean {
  let target: URL;
  try {
    target = new URL(location, window.location.origin);
  } catch {
    return false;
  }
  if (target.origin !== window.location.origin || target.pathname !== "/app") return false;

  window.requestAnimationFrame(() => {
    window.location.replace(`${target.pathname}${target.search}${target.hash}`);
  });
  return true;
}

export default function SsoLoginPrompt({ mode = "pending", initialDiagnosticStage }: SsoLoginPromptProps) {
  const isTrustedLaunch = mode === "pending" && !initialDiagnosticStage;
  const [state, setState] = useState<PromptState>(isTrustedLaunch ? "confirm" : "choice");
  const [diagnosticStage, setDiagnosticStage] = useState<string | null>(initialDiagnosticStage ?? null);
  const [showLocalLogin, setShowLocalLogin] = useState(false);

  async function continueSso() {
    setState("processing");
    setDiagnosticStage(null);

    try {
      const response = await fetch("/api/sso-login", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ system_code: "un", sso_flow: "login", confirm: true }),
        credentials: "same-origin",
        cache: "no-store",
      });

      // Older target deployments return a 303. Let Fetch follow it, then use
      // the final same-origin URL instead of trying to read a manual redirect.
      if (response.redirected && response.url) {
        if (navigateToAuthenticatedEntry(response.url)) {
          setState("complete");
          return;
        }
        setDiagnosticStage("sso_redirect_invalid");
        setState("failed");
        return;
      }

      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        // The public error contract is handled by the safe fallback below.
      }
      if (response.ok && typeof payload === "object" && payload !== null && !Array.isArray(payload)
        && (payload as { ok?: unknown }).ok === true) {
        const redirectTo = (payload as { redirectTo?: unknown }).redirectTo;
        if (typeof redirectTo !== "string" || !redirectTo.trim()) {
          setDiagnosticStage("sso_response_invalid");
          setState("failed");
          return;
        }
        if (!navigateToAuthenticatedEntry(redirectTo)) {
          setDiagnosticStage("sso_redirect_invalid");
          setState("failed");
          return;
        }
        setState("complete");
        return;
      }
      setDiagnosticStage(safeDiagnosticStage(payload));
      setState("failed");
    } catch {
      setDiagnosticStage("sso_client_request_failed");
      setState("failed");
    }
  }

  function chooseLocalLogin() {
    if (mode === "direct") {
      setShowLocalLogin(true);
      return;
    }
    setState("canceling");
    window.location.replace("/api/sso-login?system_code=un&sso_flow=login&cancel=1&local=1");
  }

  if (showLocalLogin) {
    return (
      <main className="auth-landing">
        <div className="auth-landing-pattern" aria-hidden="true" />
        <div className="auth-landing-content">
          <div className="auth-landing-brand">
            <span className="app-brand-mark" aria-hidden="true">U</span>
            <div>
              <p className="eyebrow">UNIFORM CO.</p>
              <h1>制服資產作業台</h1>
              <p>正式資料工作區</p>
            </div>
          </div>
          <AuthPanel />
          <button type="button" className="secondary-button sso-local-back" onClick={() => setShowLocalLogin(false)}>
            返回 SSO 登入選擇
          </button>
          <p className="auth-landing-footnote">安全登入 ／ 權限控管 ／ 正式資料工作區</p>
        </div>
      </main>
    );
  }

  const isChoice = state === "choice";
  const isConfirm = state === "confirm";
  const isFailed = state === "failed";
  const isBusy = state === "processing" || state === "canceling";
  const isPendingStateMissing = diagnosticStage === "sso_pending_state_missing";

  return (
    <main className="auth-landing">
      <div className="auth-landing-pattern" aria-hidden="true" />
      <div className="auth-landing-content">
        <div className="auth-landing-brand">
          <span className="app-brand-mark" aria-hidden="true">U</span>
          <div>
            <p className="eyebrow">UNIFORM CO.</p>
            <h1>制服資產作業台</h1>
            <p>正式資料工作區</p>
          </div>
        </div>

        <section
           className="sso-login-dialog panel"
           role="dialog"
           aria-modal="true"
           aria-labelledby="sso-login-title"
           aria-describedby="sso-login-description"
           aria-live="polite"
           aria-busy={isBusy}
        >
          <p className="eyebrow">SSO / SAME-ORIGIN CONFIRMATION</p>
          <h2 id="sso-login-title">{stateTitle(state)}</h2>
          <p id="sso-login-description">
            {isChoice && mode === "direct" && "是否使用中央 SSO 登入？您可以前往中央 Portal，或保留子系統原有登入方式。"}
            {isChoice && mode === "pending" && "SSO 導入狀態已失效，請重新從中央 Portal 開始，或使用子系統原有登入。"}
            {isConfirm && "目前由中央 SSO 導入；請確認是否使用中央 SSO 登入。"}
            {state === "processing" && "正在驗證 SSO 並建立目標工作階段。"}
            {state === "complete" && "SSO登入完成，正在進入制服資產作業台。"}
            {isFailed && isPendingStateMissing && "SSO 登入狀態不存在或已失效；請重新從中央 Portal 開始，或使用子系統原有登入。"}
            {isFailed && !isPendingStateMissing && "SSO 登入未完成；請重試，或改用子系統原有登入方式。"}
            {state === "canceling" && "正在返回子系統登入。"}
          </p>

          {(isFailed || (isChoice && isPendingStateMissing)) && (
            <p className="sso-login-diagnostic" role="status">
              診斷階段：{diagnosticStage ?? "sso_response_invalid"}
            </p>
          )}

          {isChoice && mode === "direct" && (
            <div className="sso-login-dialog-actions">
              <a className="primary-button" href={CENTRAL_PORTAL_URL}>前往中央 SSO 登入</a>
              <button type="button" className="secondary-button" onClick={chooseLocalLogin} disabled={isBusy}>
                否，使用子系統登入
              </button>
            </div>
          )}

          {isChoice && mode === "pending" && (
            <div className="sso-login-dialog-actions">
              <a className="primary-button" href={CENTRAL_PORTAL_URL}>重新從中央 Portal 開始</a>
              <button type="button" className="secondary-button" onClick={chooseLocalLogin} disabled={isBusy}>
                否，使用子系統登入
              </button>
            </div>
          )}

          {(isConfirm || (isFailed && !isPendingStateMissing)) && (
            <div className="sso-login-dialog-actions">
              <button type="button" className="primary-button" onClick={continueSso} disabled={isBusy}>
                {isFailed ? "重試 SSO 登入" : "繼續 SSO 登入"}
              </button>
              <button type="button" className="secondary-button" onClick={chooseLocalLogin} disabled={isBusy}>
                取消並使用子系統登入
              </button>
            </div>
          )}

          {isFailed && isPendingStateMissing && (
            <div className="sso-login-dialog-actions">
              <button type="button" className="secondary-button" onClick={chooseLocalLogin}>返回子系統登入</button>
            </div>
          )}

          {isBusy && <span className="status-pill sso-login-status" role="status" aria-live="polite">處理中</span>}
        </section>

        <p className="auth-landing-footnote">安全登入 ／ 權限控管 ／ 正式資料工作區</p>
      </div>
    </main>
  );
}
