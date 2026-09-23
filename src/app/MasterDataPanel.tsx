"use client";

import { useRef, useState } from "react";
import { invalidateEmployeeDirectory } from "@/src/lib/employee-directory-read";
import { invalidateMasterDataCache } from "@/src/lib/master-data-cache";
import { safeSupabaseMutationErrorMessage } from "@/src/lib/supabase-session";
import { classifyMasterImportOutcome, prepareMasterImportAttempt, type MasterImportAttempt } from "@/src/domain/master-data-import";
import { masterRowsToCsv, parseMasterDataCsv, parseMasterDataJson } from "@/src/domain/master-data";
import { getSampleMasterRows, type SampleMasterEntity } from "@/src/domain/master-data-samples";
import { useWorkspaceSession } from "./workspace-session";

const entityOptions = [
  ["INSTITUTIONS", "機構"],
  ["DEPARTMENTS", "部門"],
  ["UNIFORM_ITEMS", "制服品號"],
  ["SUPPLIERS", "供應商"],
  ["SUPPLIER_ITEMS", "供應商品號 MOQ"],
] as const;

export type MasterEntityType = (typeof entityOptions)[number][0];
type NoticeKind = "info" | "success" | "error";
type PanelNotice = { text: string; kind: NoticeKind };

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

type Props = {
  allowedEntityTypes?: readonly MasterEntityType[];
};

export default function MasterDataPanel({ allowedEntityTypes }: Props) {
  const { client, accountId, identityError, identityLoading, isAuthenticated } = useWorkspaceSession();
  const identityReady = Boolean(client && isAuthenticated && accountId && !identityLoading && !identityError);
  const visibleEntityOptions = allowedEntityTypes
    ? entityOptions.filter(([value]) => allowedEntityTypes.includes(value))
    : entityOptions;
  const defaultEntityType = visibleEntityOptions[0]?.[0] ?? "INSTITUTIONS";
  const [entityType, setEntityType] = useState<MasterEntityType>(defaultEntityType);
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<unknown[]>([]);
  const [sampleMode, setSampleMode] = useState(false);
  const [sampleConfirmed, setSampleConfirmed] = useState(false);
  const [notice, setNotice] = useState<PanelNotice>({ text: "尚未載入檔案", kind: "info" });
  const [busy, setBusy] = useState(false);
  const importAttemptRef = useRef<MasterImportAttempt | null>(null);
  const exportAttemptRef = useRef<{ entityType: MasterEntityType; key: string } | null>(null);

  function resetPreview() {
    importAttemptRef.current = null;
    exportAttemptRef.current = null;
    setFileName("");
    setRows([]);
    setSampleMode(false);
    setSampleConfirmed(false);
    setNotice({ text: "尚未載入檔案", kind: "info" });
  }

  function showNotice(text: string, kind: NoticeKind = "info") {
    setNotice({ text, kind });
  }

  function selectEntity(nextEntityType: MasterEntityType) {
    setEntityType(nextEntityType);
    resetPreview();
  }

  const [pasteMode, setPasteMode] = useState(false);
  const [pastedText, setPastedText] = useState("");

  function parseTextContent(rawText: string, sourceName: string) {
    importAttemptRef.current = null;
    setFileName(sourceName);
    setRows([]);
    setSampleMode(false);
    setSampleConfirmed(false);
    try {
      const trimmed = rawText.trim();
      const isCsv = sourceName.toLowerCase().endsWith(".csv") || trimmed.startsWith("code,") || trimmed.startsWith('"code"') || !trimmed.startsWith("[");
      const result = isCsv ? parseMasterDataCsv(rawText) : parseMasterDataJson(rawText);
      if (result.errors.length > 0) throw new Error(`第 ${result.errors[0].row} 列：${result.errors[0].message}`);
      setRows(result.rows);
      showNotice(`已預覽 ${result.rows.length} 列；尚未寫入資料庫`, "success");
    } catch (error) {
      setRows([]);
      showNotice(error instanceof Error ? error.message : "JSON 無法解析", "error");
    }
  }

  async function handleFile(file: File | undefined) {
    if (!file) return;
    try {
      if (file.size > 10_000_000) throw new Error("檔案超過 10 MB 上限");
      showNotice("正在讀取檔案…");
      const buffer = await file.arrayBuffer();
      let text = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
      if (text.includes("\uFFFD")) {
        try {
          const big5 = new TextDecoder("big5", { fatal: false }).decode(buffer);
          if (!big5.includes("\uFFFD")) text = big5;
        } catch {
          // keep utf-8
        }
      }
      parseTextContent(text, file.name);
    } catch (error) {
      setRows([]);
      showNotice(error instanceof Error ? error.message : "檔案無法讀取", "error");
    }
  }

  function loadSamplePreview() {
    importAttemptRef.current = null;
    const sampleRows = getSampleMasterRows(entityType as SampleMasterEntity);
    setFileName(`sample-${entityType.toLowerCase()}.csv`);
    setRows(sampleRows);
    setSampleMode(true);
    setSampleConfirmed(false);
    showNotice(`已載入 ${sampleRows.length} 列測試範例；請只在 disposable staging 使用`);
  }

  function downloadSample() {
    const sampleRows = getSampleMasterRows(entityType as SampleMasterEntity);
    const blob = new Blob([masterRowsToCsv(sampleRows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `sample-${entityType.toLowerCase()}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    showNotice("測試範例 CSV 已下載；請只在 disposable staging 使用", "success");
  }

  async function applyImport() {
    if (rows.length === 0) return;
    if (sampleMode && !sampleConfirmed) {
      showNotice("套用測試範例前，請先確認目前是 disposable staging 環境", "error");
      return;
    }
    if (!identityReady || !client) {
      showNotice("預覽模式：設定 Supabase env 並登入後，才會呼叫整批驗證／原子 upsert RPC");
      return;
    }
    setBusy(true);
    let requestStarted = false;
    try {
      const payloadSha256 = await sha256Text(JSON.stringify(rows));
      const attempt = prepareMasterImportAttempt(
        importAttemptRef.current,
        { entityType, sourceFilename: fileName, payloadSha256 },
        () => crypto.randomUUID(),
      );
      importAttemptRef.current = attempt;
      requestStarted = true;
      const { data, error } = await client.rpc("apply_master_import", {
        p_entity_type: entityType,
        p_source_filename: fileName,
        p_rows: rows,
        p_idempotency_key: `master-${attempt.idempotencyKey}`,
        p_request_fingerprint: attempt.requestFingerprint,
      });
      const outcome = classifyMasterImportOutcome(data, error);
      if (outcome.kind === "applied") {
        if (["INSTITUTIONS", "DEPARTMENTS"].includes(entityType)) invalidateEmployeeDirectory(client);
        invalidateMasterDataCache(client, ["INSTITUTIONS", "DEPARTMENTS"].includes(entityType) ? "organization" : "product");
        showNotice(`主檔匯入完成，已套用 ${outcome.rowCount || rows.length} 列。`, "success");
      } else if (outcome.kind === "rejected") {
        showNotice(`整批未套用：伺服器檢核 ${outcome.errorCount} 列錯誤；請修正資料後重新選擇檔案。`, "error");
      } else {
        showNotice("主檔匯入結果尚未確認；請使用同一檔案重試，系統會沿用同一冪等鍵，不會重複建立批次。");
      }
    } catch {
      showNotice(requestStarted
        ? "主檔匯入結果尚未確認；請使用同一檔案重試，系統會沿用同一冪等鍵，不會重複建立批次。"
        : "無法安全計算匯入資料指紋，尚未送出；請重新選擇檔案後再試。", requestStarted ? "info" : "error");
    } finally {
      setBusy(false);
    }
  }

  async function exportMasterData() {
    if (!identityReady || !client) {
      showNotice("預覽模式：登入並設定 Supabase env 後才能匯出受權限保護的主檔");
      return;
    }
    setBusy(true);
    let fileDownloaded = false;
    const existingAttempt = exportAttemptRef.current;
    const attempt = existingAttempt?.entityType === entityType
      ? existingAttempt
      : { entityType, key: crypto.randomUUID() };
    exportAttemptRef.current = attempt;
    try {
      const { data, error } = await client.rpc("export_master_data", {
        p_entity_type: entityType,
        p_idempotency_key: `master-export-${attempt.key}`,
        p_request_fingerprint: `${entityType}:csv:v1`,
      });
      if (error) {
        showNotice(safeSupabaseMutationErrorMessage(error, "主檔匯出結果尚未確認；重試會沿用相同冪等鍵，避免重複建立匯出批次。"), "error");
        return;
      }
      const exportPayload = data as { batchId?: string; rows?: unknown[] } | unknown[] | null;
      const exportRows = Array.isArray(exportPayload)
        ? exportPayload as Record<string, unknown>[]
        : Array.isArray(exportPayload?.rows)
          ? exportPayload.rows as Record<string, unknown>[]
          : [];
      const blob = new Blob([masterRowsToCsv(exportRows)], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${entityType.toLowerCase()}-export.csv`;
      anchor.click();
      URL.revokeObjectURL(url);
      fileDownloaded = true;
      exportAttemptRef.current = null;
      let auditError: { message: string } | null = null;
      if (!Array.isArray(exportPayload) && exportPayload?.batchId) {
        const auditResult = await client.rpc("record_master_export_download", { p_batch_id: exportPayload.batchId });
        auditError = auditResult.error;
      }
      showNotice(auditError ? "檔案已下載，但下載稽核尚未完成；請聯絡管理員確認。" : "匯出完成，下載事件已記錄", auditError ? "error" : "success");
    } catch {
      showNotice(fileDownloaded
        ? "檔案已下載，但下載稽核結果未知；請聯絡管理員確認。"
        : "主檔匯出結果尚未確認；重試會沿用相同冪等鍵，避免重複建立匯出批次。", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel import-panel" aria-label="主檔匯入匯出">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">06 / MASTER DATA</p>
          <h2>主檔整批匯入／匯出</h2>
        </div>
        <span className={`status-pill ${rows.length > 0 ? "success" : ""}`}>{rows.length > 0 ? "可送伺服器驗證" : "尚未選檔"}</span>
      </div>
      <p className="auth-message">支援機構、部門、制服品號、供應商與供應商 MOQ。瀏覽器只做預覽，正式驗證、冪等與原子發布由 Supabase RPC 執行。</p>
      <div className="form-grid master-tools">
        <label className="field">
          <span>主檔類型</span>
          <select value={entityType} onChange={(event) => selectEntity(event.target.value as MasterEntityType)} disabled={busy}>
            {visibleEntityOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label
          htmlFor="master-data-file-picker"
          className="file-picker"
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const droppedFile = e.dataTransfer.files?.[0];
            if (droppedFile) void handleFile(droppedFile);
          }}
        >
          <span>選擇 CSV／JSON（或拖曳檔案至此）</span>
        </label>
        <input
          id="master-data-file-picker"
          type="file"
          accept=".csv,.json,text/csv,application/json"
          style={{ position: "absolute", width: "1px", height: "1px", padding: 0, margin: "-1px", overflow: "hidden", clip: "rect(0, 0, 0, 0)", border: 0 }}
          onClick={(event) => {
            event.stopPropagation();
            event.currentTarget.value = "";
          }}
          onChange={async (event) => {
            const input = event.currentTarget;
            const file = input.files?.[0];
            try {
              if (file) await handleFile(file);
            } finally {
              input.value = "";
            }
          }}
          disabled={busy} />
      </div>
      {fileName ? <p className="file-name">{fileName}／{rows.length} 列</p> : null}
      <div className="button-row">
        <button className="secondary-button" type="button" disabled={busy} onClick={loadSamplePreview}>載入範例到預覽</button>
        <button className="secondary-button" type="button" disabled={busy} onClick={downloadSample}>下載範例 CSV</button>
        <button className="secondary-button" type="button" disabled={busy} onClick={() => setPasteMode((open) => !open)}>{pasteMode ? "收起貼上" : "或直接貼上 CSV／JSON"}</button>
      </div>
      {pasteMode ? (
        <div className="form-grid" style={{ marginTop: "8px" }}>
          <label className="field" style={{ gridColumn: "1 / -1" }}>
            <span>貼上 CSV 或 JSON 文字內容</span>
            <textarea
              rows={5}
              value={pastedText}
              onChange={(event) => setPastedText(event.target.value)}
              placeholder="請直接在此貼上包含標題列的 CSV 文字或 JSON 陣列…"
              disabled={busy}
            />
          </label>
          <div className="button-row" style={{ gridColumn: "1 / -1" }}>
            <button
              className="primary-button"
              type="button"
              disabled={busy || !pastedText.trim()}
              onClick={() => {
                parseTextContent(pastedText.trim(), `manual-${entityType.toLowerCase()}.csv`);
                setPasteMode(false);
              }}
            >
              解析並預覽貼上的內容
            </button>
          </div>
        </div>
      ) : null}
      {sampleMode ? <label className="checkbox-field"><input type="checkbox" checked={sampleConfirmed} onChange={(event) => setSampleConfirmed(event.target.checked)} disabled={busy} />我確認這是 DEMO 測試資料，且目前連線的是 disposable staging</label> : null}
      <div className="button-row">
        <button className="primary-button" type="button" disabled={busy || rows.length === 0 || (sampleMode && !sampleConfirmed)} onClick={() => void applyImport()}>確認整批匯入</button>
        <button className="secondary-button" type="button" disabled={busy} onClick={() => void exportMasterData()}>匯出目前主檔</button>
      </div>
      <p className={identityError ? "auth-message" : notice.kind === "success" ? "success-note" : "auth-message"}>{identityError ?? notice.text}</p>
    </section>
  );
}
