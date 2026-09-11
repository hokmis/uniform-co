"use client";

type ErrorPageProps = Readonly<{
  error: Error & { digest?: string };
  reset: () => void;
}>;

export default function ErrorPage({ reset }: ErrorPageProps) {
  return (
    <main className="shell">
      <section className="panel" role="alert" aria-live="assertive">
        <div className="panel-heading">
          <div>
            <h2>系統暫時無法完成這個操作</h2>
            <p>系統發生未預期錯誤，請再試一次。若持續發生，請聯絡系統管理員。</p>
          </div>
        </div>
        <div className="error-box">為保護資料安全，畫面不會顯示錯誤內容或系統細節。</div>
        <div className="button-row">
          <button className="primary-button" type="button" onClick={reset}>
            再試一次
          </button>
        </div>
      </section>
    </main>
  );
}
