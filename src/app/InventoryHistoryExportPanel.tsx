"use client";

import { useEffect, useRef, useState } from "react";
import { masterRowsToCsv } from "@/src/domain/master-data";
import { getReportDefinition } from "@/src/domain/reporting-catalog";
import { retrySupabaseQueriesAfterSessionRefresh, safeSupabaseReadErrorMessage } from "@/src/lib/supabase-session";
import { useWorkspaceSession } from "./workspace-session";
import { invalidateMasterDataCache, loadInventoryHistoryItemOptions, type InventoryHistoryItemOption } from "@/src/lib/master-data-cache";
import { usePanelActivity } from "./RetainedPanelSet";
import SearchableItemPicker from "./SearchableItemPicker";

const reportOptions = [
  ["v_item_availability", "品號可用量"],
  ["v_inventory_history", "庫存流水"],
] as const;

type ReportName = (typeof reportOptions)[number][0];
type MessageKind = "info" | "success" | "error";

export default function InventoryHistoryExportPanel() {
  const { client, isAuthenticated, accountId, identityError, identityLoading } = useWorkspaceSession();
  const hasSession = isAuthenticated;
  const panelActive = usePanelActivity();
  const identityReady = Boolean(panelActive && client && hasSession && accountId && !identityError && !identityLoading);
  const [snapshot, setSnapshot] = useState<{ accountId: string; items: InventoryHistoryItemOption[]; failed: boolean } | null>(null);
  const [reloadItemsToken, setReloadItemsToken] = useState(0);
  const [selection, setSelection] = useState<{ accountId: string; ids: string[] } | null>(null);
  const visibleItems = identityReady && snapshot?.accountId === accountId ? snapshot.items : [];
  const itemsReadFailed = identityReady && snapshot?.accountId === accountId && snapshot.failed;
  const exportItemIds = identityReady && selection?.accountId === accountId ? selection.ids : [];
  const identityRef = useRef(accountId);
  useEffect(() => {
    identityRef.current = identityReady ? accountId : null;
    return () => { identityRef.current = null; };
  }, [accountId, identityReady]);
  const [reportName, setReportName] = useState<ReportName>("v_item_availability");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("選擇資料集後可下載 CSV；匯出內容只來自目前帳號可見範圍");
  const [messageKind, setMessageKind] = useState<MessageKind>("info");
  const exportKeyRef = useRef<string | null>(null);
  const exportFingerprintRef = useRef<string | null>(null);

  useEffect(() => {
    if (!identityReady || !client || !accountId) return;
    let active = true;
    void loadInventoryHistoryItemOptions(client).then((result) => {
      if (!active) return;
      setSnapshot({ accountId, failed: result.errors.length > 0, items: result.errors.length ? [] : result.items.map((item) => ({ ...item, item_name: item.is_active ? item.item_name : `${item.item_name}（已停用）` })) });
    }).catch(() => {
      if (active) setSnapshot({ accountId, items: [], failed: true });
    });
    return () => { active = false; };
  }, [accountId, client, identityReady, reloadItemsToken]);

  function showMessage(text: string, kind: MessageKind = "info") {
    setMessage(text);
    setMessageKind(kind);
  }

  async function exportReport() {
    if (!client) {
      showMessage("預覽模式：設定 Supabase env 並登入後，才能匯出目前帳號可見的庫存資料");
      return;
    }
    if (identityLoading || !hasSession || !accountId || identityError) {
      showMessage("目前登入帳號尚未完成工作區身份查核，請重新整理後再試。", "error");
      return;
    }
    setBusy(true);
    let downloaded = false;
    try {
      const report = getReportDefinition(reportName);
      const [result] = await retrySupabaseQueriesAfterSessionRefresh(
        client,
        async () => {
          let query = client.from(reportName).select(report.columns.join(","));
          if (exportItemIds.length) query = query.in("item_id", exportItemIds);
          query = reportName === "v_inventory_history"
            ? query.order("posted_at", { ascending: false }).order("ledger_entry_id", { ascending: false })
            : query.order("item_code", { ascending: true });
          return [await query.limit(2000)] as const;
        },
      );
      if (identityRef.current !== accountId) return;
      if (result.error) {
        showMessage(`匯出失敗：${safeSupabaseReadErrorMessage(result.error)}`, "error");
        return;
      }
      const rows = (result.data ?? []) as unknown as Record<string, unknown>[];
      const blob = new Blob([masterRowsToCsv(rows)], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${reportName}-${new Date().toISOString().slice(0, 10)}.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
      downloaded = true;
      const exportKey = exportKeyRef.current ?? crypto.randomUUID();
      const exportFingerprint = exportFingerprintRef.current ?? JSON.stringify({ reportName, itemIds: [...exportItemIds].sort(), rowCount: rows.length });
      exportKeyRef.current = exportKey;
      exportFingerprintRef.current = exportFingerprint;
      const auditResult = await client.rpc("record_report_export", {
        p_report_name: reportName,
        p_row_count: rows.length,
        p_idempotency_key: `REPORT-EXPORT-${exportKey}`,
        p_request_fingerprint: exportFingerprint,
      });
      if (auditResult.error) {
        showMessage(`已下載 ${rows.length} 筆，但匯出稽核未完成：${safeSupabaseReadErrorMessage(auditResult.error)}`, "error");
      } else {
        showMessage(`已下載 ${rows.length} 筆${report.label}；匯出事件已記錄`, "success");
        exportKeyRef.current = null;
        exportFingerprintRef.current = null;
      }
    } catch {
      showMessage(downloaded
        ? "檔案已下載，但匯出稽核結果尚未確認；請重試同一個匯出作業。"
        : "匯出結果尚未確認；請檢查連線後重試。", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel" aria-label="庫存資料匯出">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">INVENTORY EXPORT</p>
          <h2>庫存查詢與歷史匯出</h2>
        </div>
        <span className="status-pill">CSV／權限範圍</span>
      </div>
      <p className="auth-message">匯出最多 2,000 筆即時資料；庫存流水是 append-only 來源，不提供刪除或覆寫。正式庫存變更請使用期初、入庫、發貨、盤點、退回或更正作業。</p>
      <div className="form-grid">
        <label className="field"><span>匯出資料集</span><select value={reportName} onChange={(event) => { exportKeyRef.current = null; exportFingerprintRef.current = null; setReportName(event.target.value as ReportName); }} disabled={busy}>{reportOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <div className="field"><span>品號範圍（未選取時匯出全部可見品號）</span><SearchableItemPicker label="匯出品號" placeholder="搜尋品號、品名或尺寸" options={visibleItems.map((item) => ({ id: item.id, code: item.item_code, name: item.item_name, size: item.size }))} value={exportItemIds} multiple onChange={(value) => { if (Array.isArray(value) && accountId) { setSelection({ accountId, ids: value }); exportKeyRef.current = null; exportFingerprintRef.current = null; } }} disabled={busy || !identityReady} /><small>{exportItemIds.length ? `只匯出所選 ${exportItemIds.length} 個品號` : "全部可見品號，包含停用品號的歷史紀錄"}</small></div>
        <div className="field"><span>&nbsp;</span><button className="secondary-button" type="button" onClick={() => void exportReport()} disabled={busy || !identityReady}>{busy ? "匯出中…" : "下載 CSV"}</button></div>
      </div>
      {itemsReadFailed ? <p className="auth-message" role="status">品號選項暫時無法載入；仍可匯出全部可見資料或保留原選取範圍重試。</p> : null}
      <button className="secondary-button" type="button" disabled={busy || !identityReady} onClick={() => {
        if (!client) return;
        invalidateMasterDataCache(client, "history-items");
        setReloadItemsToken((value) => value + 1);
      }}>重新載入品號</button>
      <p className={messageKind === "success" ? "success-note" : "auth-message"} role="status">{message}</p>
    </section>
  );
}
