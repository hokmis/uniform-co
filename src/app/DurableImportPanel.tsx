"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { durableImportFingerprintPayload, durableImportLabels, durableImportMappingVersion, durableImportMimeForFilename, durableImportTypes, type DurableImportType } from "@/src/domain/durable-import";
import { getSampleDurableRows } from "@/src/domain/master-data-samples";
import { masterRowsToCsv } from "@/src/domain/master-data";
import { canChangeDurableImportType, formatDurableImportCount, formatDurableImportDate } from "@/src/domain/durable-import-ui";
import { canonicalFingerprint } from "@/src/lib/fingerprint";
import { getSupabaseBrowserClient } from "@/src/lib/supabase-browser";

type ImportBatch = {
  id: string;
  batch_no: string;
  import_type: DurableImportType;
  status: string;
  original_filename: string;
  expected_mime_type: string;
  expected_size_bytes: number;
  storage_bucket: string;
  storage_object_key: string;
  upload_expires_at: string;
  mapping_version: string;
  row_count: number;
  valid_row_count: number;
  error_row_count: number;
  last_error_code: string | null;
  last_error_message: string | null;
};

type ImportRow = {
  row_number: number;
  proposed_action: "INSERT" | "UPDATE" | "SKIP" | "ERROR" | null;
  validation_errors: unknown;
  import_field_diffs?: Array<{ field_name: string; old_value: unknown; new_value: unknown; confirmed: boolean }>;
};

type DurableImportRecovery = {
  importType: DurableImportType;
  fileName: string;
  sizeBytes: number;
  operationKey: string;
  batchId: string | null;
  cancelKey: string | null;
  confirmKey: string | null;
};

const defaultRecoveryStorageKey = "uniform-co:durable-import-recovery";

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const statusLabels: Record<string, string> = {
  AWAITING_UPLOAD: "等待檔案上傳／worker 確認",
  UPLOADED: "已上傳，等待解析 worker",
  PARSING: "解析中",
  VALIDATING: "驗證中",
  VALIDATED: "待使用者確認發布",
  APPLYING: "套用中",
  APPLIED: "已套用",
  FAILED: "失敗，請查看錯誤",
  CANCELLED: "已取消",
};

type Props = {
  allowedImportTypes?: readonly DurableImportType[];
  recoveryStorageKey?: string;
};

export default function DurableImportPanel({ allowedImportTypes, recoveryStorageKey = defaultRecoveryStorageKey }: Props) {
  const client = getSupabaseBrowserClient();
  const visibleImportTypes = useMemo(
    () => durableImportTypes.filter((type) => !allowedImportTypes || allowedImportTypes.includes(type)),
    [allowedImportTypes],
  );
  const defaultImportType = visibleImportTypes[0] ?? "EMPLOYEES";
  const [importType, setImportType] = useState<DurableImportType>(defaultImportType);
  const [file, setFile] = useState<File | null>(null);
  const [batch, setBatch] = useState<ImportBatch | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [sampleMode, setSampleMode] = useState(false);
  const [sampleConfirmed, setSampleConfirmed] = useState(false);
  const [cancelReason, setCancelReason] = useState("使用者取消未完成匯入");
  const [differencesReviewed, setDifferencesReviewed] = useState(false);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [rowsLoadedForBatch, setRowsLoadedForBatch] = useState<string | null>(null);
  const operationRef = useRef<string | null>(null);
  const cancelOperationRef = useRef<string | null>(null);
  const confirmOperationRef = useRef<string | null>(null);
  const recoveryRef = useRef<DurableImportRecovery | null>(null);

  const persistRecovery = useCallback((overrides: Partial<DurableImportRecovery> = {}) => {
    if (typeof window === "undefined") return;
    const current = recoveryRef.current ?? {
      importType,
      fileName: file?.name ?? "",
      sizeBytes: file?.size ?? 0,
      operationKey: operationRef.current ?? crypto.randomUUID(),
      batchId: batch?.id ?? null,
      cancelKey: cancelOperationRef.current,
      confirmKey: confirmOperationRef.current,
    };
    const next = { ...current, ...overrides };
    recoveryRef.current = next;
    window.localStorage.setItem(recoveryStorageKey, JSON.stringify(next));
  }, [batch?.id, file, importType, recoveryStorageKey]);

  const refreshBatch = useCallback(async (batchId: string): Promise<ImportBatch | null> => {
    if (!client || !batchId) return null;
    const { data, error } = await client.from("import_batches")
      .select("id,batch_no,import_type,status,original_filename,expected_mime_type,expected_size_bytes,storage_bucket,storage_object_key,upload_expires_at,mapping_version,row_count,valid_row_count,error_row_count,last_error_code,last_error_message")
      .eq("id", batchId).maybeSingle();
    if (!error && data && typeof data.id === "string") {
      const refreshedBatch = data as ImportBatch;
      if (["VALIDATED", "FAILED", "APPLYING", "APPLIED"].includes(data.status)) {
        const rowResult = await client.from("import_rows")
          .select("row_number,proposed_action,validation_errors,import_field_diffs(field_name,old_value,new_value,confirmed)")
          .eq("batch_id", batchId).order("row_number").limit(10000);
        if (!rowResult.error) setRows((rowResult.data ?? []) as unknown as ImportRow[]);
        if (!rowResult.error) setRowsLoadedForBatch(batchId);
        else setRowsLoadedForBatch(null);
      } else {
        setRows([]);
        setRowsLoadedForBatch(null);
      }
      setBatch(refreshedBatch);
      return refreshedBatch;
    }
    return null;
  }, [client]);

  useEffect(() => {
    if (!client) return;
    const recoveryClient = client;
    let active = true;
    async function recover() {
      try {
        const raw = window.localStorage.getItem(recoveryStorageKey);
        if (!raw) return;
        const saved = JSON.parse(raw) as DurableImportRecovery;
        if (!saved.operationKey || !saved.importType) return;
        if (!visibleImportTypes.includes(saved.importType)) return;
        recoveryRef.current = saved;
        operationRef.current = saved.operationKey;
        cancelOperationRef.current = saved.cancelKey;
        confirmOperationRef.current = saved.confirmKey;
        setImportType(saved.importType);
        let recoveredBatch: ImportBatch | null = null;
        if (saved.batchId) {
          const { data } = await recoveryClient.from("import_batches")
            .select("id,batch_no,import_type,status,original_filename,expected_mime_type,expected_size_bytes,storage_bucket,storage_object_key,upload_expires_at,mapping_version,row_count,valid_row_count,error_row_count,last_error_code,last_error_message")
            .eq("id", saved.batchId).maybeSingle();
          recoveredBatch = data as ImportBatch | null;
        } else {
          const { data } = await recoveryClient.rpc("get_import_upload_status", {
            p_import_type: saved.importType,
            p_idempotency_key: `IMPORT-UPLOAD-${saved.operationKey}`,
          });
          recoveredBatch = data as ImportBatch | null;
        }
        if (!active || !recoveredBatch || typeof recoveredBatch.id !== "string") return;
        const refreshedBatch = await refreshBatch(recoveredBatch.id);
        if (!active) return;
        const visibleBatch = refreshedBatch ?? recoveredBatch;
        if (!refreshedBatch) setBatch(visibleBatch);
        setMessage(`已恢復批次 ${visibleBatch.batch_no ?? "未知批次"}；重試會沿用原冪等鍵。若狀態需要上傳，請重新選同一檔案。`);
      } catch {
        recoveryRef.current = null;
      }
    }
    void recover();
    return () => { active = false; };
  }, [client, refreshBatch, recoveryStorageKey, visibleImportTypes]);

  useEffect(() => {
    if (!batch?.id || !client || ["APPLIED", "FAILED", "CANCELLED"].includes(batch.status)) return;
    const timer = window.setInterval(() => { void refreshBatch(batch.id); }, 5000);
    return () => window.clearInterval(timer);
  }, [batch, client, refreshBatch]);

  function resetForNewFile(nextFile: File | null, isSample = false) {
    operationRef.current = null;
    cancelOperationRef.current = null;
    confirmOperationRef.current = null;
    setRows([]);
    setRowsLoadedForBatch(null);
    setDifferencesReviewed(false);
    setBatch(null);
    setFile(nextFile);
    setMessage("");
    setSampleMode(isSample);
    setSampleConfirmed(false);
    if (!nextFile && typeof window !== "undefined") {
      recoveryRef.current = null;
      window.localStorage.removeItem(recoveryStorageKey);
    }
  }

  function selectFile(nextFile: File | null, isSample = false) {
    const saved = recoveryRef.current;
    if (nextFile && saved && saved.fileName === nextFile.name && saved.sizeBytes === nextFile.size) {
      setFile(nextFile);
      setSampleMode(false);
      setSampleConfirmed(false);
      setImportType(saved.importType);
      operationRef.current = saved.operationKey;
      cancelOperationRef.current = saved.cancelKey;
      confirmOperationRef.current = saved.confirmKey;
      setMessage("已恢復同一檔案的匯入操作；重試會沿用原冪等鍵。");
      return;
    }
    resetForNewFile(nextFile, isSample);
  }

  function startNewBatch() {
    resetForNewFile(null);
    setImportType(defaultImportType);
    setCancelReason("使用者取消未完成匯入");
  }

  function loadSampleFile() {
    const sampleRows = getSampleDurableRows(importType);
    const sampleFile = new File(
      [masterRowsToCsv(sampleRows)],
      `sample-${importType.toLowerCase()}.csv`,
      { type: "text/csv" },
    );
    selectFile(sampleFile, true);
    setMessage(`已載入 ${sampleRows.length} 列測試範例；請只在 disposable staging 使用`);
  }

  function downloadSampleFile() {
    const sampleRows = getSampleDurableRows(importType);
    const blob = new Blob([masterRowsToCsv(sampleRows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `sample-${importType.toLowerCase()}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
    setMessage("測試範例 CSV 已下載；請只在 disposable staging 使用");
  }

  async function startUpload() {
    if (!client || !file) {
      setMessage(client ? "請先選擇 CSV 或 XLSX 檔案。" : "預覽模式：設定 Supabase env 並登入後才能建立 durable batch。");
      return;
    }
    if (sampleMode && !sampleConfirmed) {
      setMessage("上傳測試範例前，請先確認目前是 disposable staging 環境");
      return;
    }
    const mimeType = durableImportMimeForFilename(file.name);
    if (!mimeType) { setMessage("只接受 .csv 或 .xlsx；不接受 .xls、.xlsm 或其他格式。"); return; }
    if (file.size < 1 || file.size > 10_000_000) { setMessage("檔案大小必須介於 1 byte 與 10 MB。"); return; }
    setBusy(true); setMessage("");
    const operationKey = operationRef.current ?? crypto.randomUUID();
    operationRef.current = operationKey;
    persistRecovery({ operationKey, importType, fileName: file.name, sizeBytes: file.size });
    const ttlSeconds = 1800;
    const payload = durableImportFingerprintPayload({
      importType, filename: file.name, mimeType, sizeBytes: file.size,
      mappingVersion: durableImportMappingVersion[importType], ttlSeconds,
    });
    const { data, error } = await client.rpc("start_import_upload", {
      p_import_type: importType,
      p_original_filename: payload.filename,
      p_expected_mime_type: payload.mime,
      p_expected_size_bytes: payload.size,
      p_mapping_version: payload.mapping_version,
      p_upload_ttl_seconds: ttlSeconds,
      p_idempotency_key: `IMPORT-UPLOAD-${operationKey}`,
      p_request_fingerprint: await canonicalFingerprint(payload),
    });
    if (error || !data?.id) {
      setMessage(`建立上傳批次失敗或結果未知：${error?.message ?? "請沿用同一檔案重試"}`);
      setBusy(false); return;
    }
    const nextBatch = data as ImportBatch;
    const refreshedBatch = await refreshBatch(nextBatch.id);
    const activeBatch = refreshedBatch ?? nextBatch;
    if (!activeBatch.storage_bucket || !activeBatch.storage_object_key) {
      setMessage("批次已建立，但回傳欄位不完整；請按重新查詢批次後再重試。不要另建批次。");
      setBusy(false); return;
    }
    setBatch(activeBatch);
    persistRecovery({ batchId: activeBatch.id });
    if (activeBatch.status !== "AWAITING_UPLOAD") {
      setMessage(`已查回批次 ${activeBatch.batch_no ?? "未知批次"}，目前狀態：${statusLabels[activeBatch.status] ?? activeBatch.status}`);
      setBusy(false); return;
    }
    let fileHash: string;
    try {
      fileHash = await sha256Hex(file);
    } catch (error) {
      setMessage(`檔案雜湊計算失敗：${error instanceof Error ? error.message : "未知錯誤"}。請保留同一批次重試。`);
      setBusy(false);
      return;
    }
    const uploadResult = await client.storage.from(activeBatch.storage_bucket).upload(activeBatch.storage_object_key, file, {
      cacheControl: "3600",
      contentType: mimeType,
      upsert: false,
      metadata: { mimetype: mimeType, size: String(file.size), sha256: fileHash },
    });
    if (uploadResult.error) {
      setMessage(`檔案上傳結果未知：${uploadResult.error.message}。請保留同一檔案與批次重試，不會另建 batch。`);
    } else {
      setMessage(`檔案已直傳固定 private key；等待 worker 核對 MIME／大小／SHA-256 後進入解析。批次：${activeBatch.batch_no ?? "未知批次"}`);
    }
    setBusy(false);
  }

  async function cancelBatch() {
    if (!client || !batch) {
      setMessage("目前沒有可取消的批次。" );
      return;
    }
    if (typeof batch.id !== "string" || !batch.id.trim()) {
      setMessage("目前批次缺少有效識別碼，請先按重新查詢批次。" );
      return;
    }
    if (!cancelReason.trim()) {
      setMessage("取消批次前請填寫理由。" );
      return;
    }
    setBusy(true);
    const key = cancelOperationRef.current ?? crypto.randomUUID();
    cancelOperationRef.current = key;
    persistRecovery({ cancelKey: key });
    const payload = { batch_id: batch.id, reason: cancelReason.trim() };
    const { data, error } = await client.rpc("cancel_import_batch", {
      p_batch_id: batch.id,
      p_reason: payload.reason,
      p_idempotency_key: `IMPORT-CANCEL-${key}`,
      p_request_fingerprint: await canonicalFingerprint(payload),
    });
    if (error) setMessage(`取消失敗或結果未知：${error.message}；請沿用同一批次重試。`);
    else { setBatch(data as ImportBatch); setMessage("批次已取消；固定 Storage object 會由受保護清理工作依引用與保存政策處理。"); cancelOperationRef.current = null; persistRecovery({ cancelKey: null }); }
    setBusy(false);
  }

  async function reloadBatch() {
    if (!batch?.id) {
      setMessage("目前批次缺少有效識別碼，請重新整理頁面恢復批次。" );
      return;
    }
    setBusy(true);
    const refreshedBatch = await refreshBatch(batch.id);
    setMessage(refreshedBatch ? `已重新查詢批次 ${refreshedBatch.batch_no}。` : "查不到目前批次，請確認登入帳號仍有匯入讀取權限。" );
    setBusy(false);
  }

  async function confirmBatch() {
    if (!client || !batch || batch.status !== "VALIDATED") return;
    if (rowsLoadedForBatch !== batch.id) {
      setMessage("正在載入完整逐列差異，請稍候再確認發布。" );
      return;
    }
    const unconfirmedDifferences = rows.flatMap((row) => row.import_field_diffs ?? []).filter((diff) => !diff.confirmed);
    if (unconfirmedDifferences.length > 0 && !differencesReviewed) {
      setMessage(`請先勾選已檢查全部 ${unconfirmedDifferences.length} 筆欄位差異，再確認發布。`);
      return;
    }
    setBusy(true); setMessage("");
    const key = confirmOperationRef.current ?? crypto.randomUUID();
    confirmOperationRef.current = key;
    persistRecovery({ confirmKey: key });
    const payload = { batch_id: batch.id };
    const { data, error } = await client.rpc("confirm_import_batch", {
      p_batch_id: batch.id,
      p_idempotency_key: `IMPORT-CONFIRM-${key}`,
      p_request_fingerprint: await canonicalFingerprint(payload),
    });
    if (error) setMessage(`確認發布失敗或結果未知：${error.message}；請沿用同一按鈕重試。`);
    else { setBatch(data as ImportBatch); setMessage("已記錄使用者確認；worker 將在受 fencing 保護的 APPLY 階段發布整批資料。"); confirmOperationRef.current = null; setDifferencesReviewed(false); persistRecovery({ confirmKey: null }); }
    setBusy(false);
  }

  if (!client) return <section className="panel import-panel" aria-label="耐久匯入批次"><div className="panel-heading"><div><p className="eyebrow">06 / DURABLE IMPORT</p><h2>耐久匯入批次</h2></div><span className="status-pill">預覽模式</span></div><p className="auth-message">設定 Supabase env 並登入後，才能直傳固定 private Storage key；解析與正式套用由受控 worker 完成。</p></section>;
  const canChangeType = canChangeDurableImportType(busy, batch?.status);
  const canCancel = batch && !["APPLIED", "FAILED", "CANCELLED"].includes(batch.status);
  return <section className="panel import-panel" aria-label="耐久匯入批次">
    <div className="panel-heading"><div><p className="eyebrow">06 / DURABLE IMPORT</p><h2>檔案上傳與耐久匯入</h2></div><span className={`status-pill ${batch?.status === "APPLIED" ? "success" : batch?.status === "FAILED" ? "danger" : ""}`}>{batch ? statusLabels[batch.status] ?? batch.status : "尚未建立批次"}</span></div>
    <p className="auth-message">瀏覽器只把 CSV／XLSX 直傳到資料庫建立的 private key；不把檔案送進 Vercel request，也不持有 worker／service-role 權限。worker 確認檔案後才解析、預覽差異，使用者確認後才 APPLY。</p>
    <div className="form-grid master-tools">
      <label className="field"><span>匯入類型</span><select value={importType} onChange={(event) => { if (!canChangeDurableImportType(false, batch?.status)) return; resetForNewFile(null); setImportType(event.target.value as DurableImportType); }} disabled={!canChangeType}>{visibleImportTypes.map((type) => <option key={type} value={type}>{durableImportLabels[type]}</option>)}</select></label>
      <label className="file-picker"><span>選擇 CSV／XLSX</span><input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => selectFile(event.target.files?.[0] ?? null)} disabled={busy || Boolean(batch && batch.status !== "AWAITING_UPLOAD")} /></label>
    </div>
    {batch && !canChangeType ? <p className="muted">目前批次仍在處理中；請先取消或完成目前批次，才能切換匯入類型。</p> : null}
    <div className="button-row"><button className="secondary-button" type="button" onClick={loadSampleFile} disabled={!canChangeType}>載入範例檔案</button><button className="secondary-button" type="button" onClick={downloadSampleFile} disabled={!canChangeType}>下載範例 CSV</button></div>
    {sampleMode ? <label className="checkbox-field"><input type="checkbox" checked={sampleConfirmed} onChange={(event) => setSampleConfirmed(event.target.checked)} disabled={busy} />我確認這是 DEMO 測試資料，且目前連線的是 disposable staging</label> : null}
    {file ? <p className="file-name">{file.name}／{Math.ceil(file.size / 1024)} KB／{durableImportMimeForFilename(file.name)}</p> : null}
    <div className="button-row"><button className="primary-button" type="button" onClick={() => void startUpload()} disabled={busy || !file || Boolean(batch && batch.status !== "AWAITING_UPLOAD")}>{busy ? "處理中…" : batch ? "重試目前批次" : "建立批次並直傳"}</button>{batch?.status === "VALIDATED" ? <button className="primary-button" type="button" onClick={() => void confirmBatch()} disabled={busy || rowsLoadedForBatch !== batch.id}>確認發布整批</button> : null}{canCancel ? <button className="secondary-button" type="button" onClick={() => void cancelBatch()} disabled={busy}>取消批次</button> : null}{batch && !["APPLIED", "FAILED", "CANCELLED"].includes(batch.status) ? <button className="secondary-button" type="button" onClick={() => void reloadBatch()} disabled={busy}>重新查詢批次</button> : null}{batch && ["APPLIED", "FAILED", "CANCELLED"].includes(batch.status) ? <button className="secondary-button" type="button" onClick={startNewBatch} disabled={busy}>建立新批次</button> : null}</div>
    {canCancel ? <label className="field"><span>取消理由（必填）</span><input value={cancelReason} onChange={(event) => { cancelOperationRef.current = null; setCancelReason(event.target.value); }} disabled={busy} /></label> : null}
    {batch ? <div className="summary-list"><p className="file-name">批次 {batch.batch_no ?? "未知批次"}／{batch.status}／預期 {formatDurableImportCount(batch.expected_size_bytes)} bytes／期限 {formatDurableImportDate(batch.upload_expires_at)}</p><p className="muted">解析列數：{formatDurableImportCount(batch.row_count)}；有效：{formatDurableImportCount(batch.valid_row_count)}；錯誤：{formatDurableImportCount(batch.error_row_count)}{batch.last_error_message ? `／${batch.last_error_message}` : ""}</p>{rows.filter((row) => Array.isArray(row.validation_errors) && row.validation_errors.length > 0).slice(0, 10).map((row) => <p className="auth-message" key={`error-${row.row_number}`}>第 {row.row_number} 列：{JSON.stringify(row.validation_errors)}</p>)}{rows.flatMap((row) => row.import_field_diffs ?? []).filter((diff) => !diff.confirmed).slice(0, 10).map((diff, index) => <p className="auth-message" key={`diff-${diff.field_name}-${index}`}>待確認差異：{diff.field_name}／舊值 {JSON.stringify(diff.old_value)}／新值 {JSON.stringify(diff.new_value)}</p>)}{batch.status === "VALIDATED" && rowsLoadedForBatch === batch.id && rows.flatMap((row) => row.import_field_diffs ?? []).filter((diff) => !diff.confirmed).length > 0 ? <label className="checkbox-field"><input type="checkbox" checked={differencesReviewed} onChange={(event) => setDifferencesReviewed(event.target.checked)} disabled={busy} />我已檢查全部欄位差異，同意按預覽結果整批發布（畫面列出前 10 筆，完整差異以後端逐列紀錄保存）</label> : null}</div> : null}
    {message ? <p className={message.startsWith("檔案已") || message.startsWith("批次已") ? "success-note" : "auth-message"} role="status">{message}</p> : null}
  </section>;
}
