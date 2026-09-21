"use client";

export default function WorkspacePanelLoading({ label = "正在載入模組" }: { label?: string }) {
  return (
    <section className="panel workspace-loading-shell" aria-label={label} aria-busy="true">
      <div className="workspace-loading-heading">
        <p className="eyebrow">MODULE</p>
        <h2>{label}</h2>
      </div>
      <p className="sr-only" role="status" aria-live="polite">{label}，請稍候。</p>
      <div className="workspace-loading-skeleton" aria-hidden="true">
        <div className="workspace-loading-lines">
          <span className="workspace-loading-line-wide" />
          <span className="workspace-loading-line-medium" />
        </div>
        <div className="workspace-loading-cards"><span /><span /><span /></div>
      </div>
    </section>
  );
}
