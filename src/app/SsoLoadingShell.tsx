type SsoLoadingShellProps = {
  title?: string;
  message?: string;
};

export default function SsoLoadingShell({
  title = "SSO帳號登入中",
  message = "正在準備安全登入畫面，請稍候…",
}: SsoLoadingShellProps) {
  return (
    <main className="auth-landing auth-landing-loading" aria-busy="true">
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
          className="sso-login-dialog sso-login-dialog-loading panel"
          role="status"
          aria-live="polite"
          aria-label={title}
        >
          <p className="eyebrow">SSO / SAME-ORIGIN CONFIRMATION</p>
          <div className="sso-login-loading-heading">
            <span className="sso-login-loading-orb" aria-hidden="true" />
            <h2>{title}</h2>
          </div>
          <p>{message}</p>
          <div className="sso-login-skeleton" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <span className="status-pill sso-login-status" aria-hidden="true">處理中</span>
        </section>

        <p className="auth-landing-footnote">安全登入 ／ 權限控管 ／ 正式資料工作區</p>
      </div>
    </main>
  );
}
