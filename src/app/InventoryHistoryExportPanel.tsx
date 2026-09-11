"use client";

import { useRef, useState } from "react";
import { masterRowsToCsv } from "@/src/domain/master-data";
import { getSupabaseBrowserClient } from "@/src/lib/supabase-browser";

const reportOptions = [
  ["v_item_availability", "品號可用量"],
  ["v_inventory_history", "庫存流水"],
] as const;

type ReportName = (typeof reportOptions)[number][0];

export default function InventoryHistoryExportPanel() {
  const [reportName, setReportName] = useState<ReportName>("v_item_availability");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("選擇資料集後可下載 CSV；匯出內容只來自目前帳號可讀取的 RLS 範圍");
  const exportKeyRef = useRef<string | null>(null);
  const exportFingerprintRef = useRef<string | null>(null);

  async function exportReport() {
    const client = getSupabaseBrowserClient();
    if (!client) {
      setMessage("預覽模式：設定 Supabase env 並登入後，才能匯出受 RLS 保護的庫存資料");
      return;
    }
    setBusy(true);
    const result = await client.from(reportName).select("*").limit(2000);
    if (result.error) {
      setMessage(`匯出失敗：${result.error.message}`);
      setBusy(false);
      return;
    }
    const rows = (result.data ?? []) as Record<string, unknown>[];
    const blob = new Blob([masterRowsToCsv(rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${reportName}-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    const exportKey = exportKeyRef.current ?? crypto.randomUUID();
    const exportFingerprint = exportFingerprintRef.current ?? JSON.stringify({ reportName, rowCount: rows.length });
    exportKeyRef.current = exportKey;
    exportFingerprintRef.current = exportFingerprint;
    const auditResult = await client.rpc("record_report_export", {
      p_report_name: reportName,
      p_row_count: rows.length,
      p_idempotency_key: `REPORT-EXPORT-${exportKey}`,
      p_request_fingerprint: exportFingerprint,
    });
    setMessage(auditResult.error
      ? `已下載 ${rows.length} 筆，但匯出稽核未完成：${auditResult.error.message}`
      : `已下載 ${rows.length} 筆 ${reportName}；匯出事件已記錄`);
    if (!auditResult.error) {
      exportKeyRef.current = null;
      exportFingerprintRef.current = null;
    }
    setBusy(false);
  }

  return (
    <section className="panel" aria-label="庫存資料匯出">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">INVENTORY EXPORT</p>
          <h2>庫存查詢與歷史匯出</h2>
        </div>
        <span className="status-pill">CSV / RLS</span>
      </div>
      <p className="auth-message">匯出最多 2,000 筆即時資料；庫存流水是 append-only 來源，不提供刪除或覆寫。正式庫存變更請使用期初、入庫、發貨、盤點、退回或更正作業。</p>
      <div className="form-grid">
        <label className="field"><span>匯出資料集</span><select value={reportName} onChange={(event) => { exportKeyRef.current = null; exportFingerprintRef.current = null; setReportName(event.target.value as ReportName); }} disabled={busy}>{reportOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <div className="field"><span>&nbsp;</span><button className="secondary-button" type="button" onClick={() => void exportReport()} disabled={busy}>{busy ? "匯出中…" : "下載 CSV"}</button></div>
      </div>
      <p className="success-note" role="status">{message}</p>
    </section>
  );
}
