import type { ReactNode } from "react";

function SsoBindingNotice() {
  return (
    <section className="sso-binding-notice panel" role="status" aria-live="polite">
      <div>
        <p className="eyebrow">SSO / ACCOUNT BINDING</p>
        <h2>SSO帳號綁定中</h2>
        <p>請先使用子系統原有登入方式登入；登入後會由系統完成安全綁定。</p>
      </div>
      <span className="status-pill">綁定中</span>
    </section>
  );
}

export default function AuthLanding({ children, bindingPending = false }: { children: ReactNode; bindingPending?: boolean }) {
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
        {bindingPending && <SsoBindingNotice />}
        {children}
        <p className="auth-landing-footnote">安全登入 ／ 權限控管 ／ 正式資料工作區</p>
      </div>
    </main>
  );
}
