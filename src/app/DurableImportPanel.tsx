"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { durableImportFingerprintPayload, durableImportLabels, durableImportMappingVersion, durableImportMimeForFilename, durableImportTypes, type DurableImportType } from "@/src/domain/durable-import";
import { getSampleDurableRows } from "@/src/domain/master-data-samples";
import { masterRowsToCsv } from "@/src/domain/master-data";
import { canChangeDurableImportType, formatDurableImportCount, formatDurableImportDate, isDurableImportAwaitingUpload, isDurableImportObjectAlreadyUploaded, isDurableImportProcessingStatus, isDurableImportRowsVisibleStatus, isDurableImportTerminalStatus, summarizeDurableImportPreview } from "@/src/domain/durable-import-ui";
import { workflowStatusLabel, workflowStatusTone } from "@/src/domain/workflow-status";
import { canonicalFingerprint } from "@/src/lib/fingerprint";
import { kickImportWorkerUntilYielded } from "@/src/lib/import-worker-client";
import { retrySupabaseQueriesAfterSessionRefresh, safeSupabaseMutationErrorMessage } from "@/src/lib/supabase-session";
import { notifyInventoryDataChanged } from "@/src/domain/inventory-events";
import { createReadRequestController, type ReadRequestController } from "@/src/domain/read-refresh";
import { useWorkspaceSession } from "./workspace-session";
import { usePanelActivity } from "./RetainedPanelSet";
import { useWorkflowStatusPoll } from "./use-workflow-status-poll";

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
};

type BatchReadResult = {
  batch: ImportBatch | null;
  isCurrent: boolean;
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

type Props = {
  allowedImportTypes?: readonly DurableImportType[];
  recoveryStorageKey?: string;
};

export default function DurableImportPanel({ allowedImportTypes, recoveryStorageKey = defaultRecoveryStorageKey }: Props) {
  const { client, isAuthenticated, accountId, identityError, identityLoading } = useWorkspaceSession();
  const panelActive = usePanelActivity();
  const hasSession = isAuthenticated;
  const operationReady = Boolean(client && hasSession && accountId && !identityLoading && !identityError);
  const visibleImportTypes = useMemo(
    () => durableImportTypes.filter((type) => !allowedImportTypes || allowedImportTypes.includes(type)),
    [allowedImportTypes],
  );
  const defaultImportType = visibleImportTypes[0] ?? "EMPLOYEES";
  const [importType, setImportType] = useState<DurableImportType>(defaultImportType);
  const [file, setFile] = useState<File | null>(null);
  const [batch, setBatch] = useState<ImportBatch | null>(null);
  const [busy, setBusy] = useState(false);
  const [dataLoading, setDataLoading] = useState(false);
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [sampleMode, setSampleMode] = useState(false);
  const [sampleConfirmed, setSampleConfirmed] = useState(false);
  const [cancelReason, setCancelReason] = useState("使用者取消未完成匯入");
  const [cancelFormOpen, setCancelFormOpen] = useState(false);
  const [differencesReviewed, setDifferencesReviewed] = useState(false);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [rowsLoadedForBatch, setRowsLoadedForBatch] = useState<string | null>(null);
  const previewSummary = useMemo(() => summarizeDurableImportPreview(rows), [rows]);
  const operationRef = useRef<string | null>(null);
  const cancelOperationRef = useRef<string | null>(null);
  const confirmOperationRef = useRef<string | null>(null);
  const recoveryRef = useRef<DurableImportRecovery | null>(null);
  const edgeProcessingRef = useRef(false);
  const readGenerationRef = useRef(0);
  const readControllerRef = useRef<ReadRequestController | null>(null);
  const reloadSequenceRef = useRef(0);

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

  const refreshBatchDetailed = useCallback(async (batchId: string, showLoading = true): Promise<BatchReadResult> => {
    if (!operationReady || !batchId || !client) return { batch: null, isCurrent: false };
    const readController = readControllerRef.current ?? createReadRequestController();
    readControllerRef.current = readController;
    const readSequence = readController.begin();
    const readGeneration = readGenerationRef.current;
    if (showLoading) setDataLoading(true);
    try {
      const [batchResult] = await retrySupabaseQueriesAfterSessionRefresh(
        client,
        async () => [await client.from("import_batches")
          .select("id,batch_no,import_type,status,original_filename,expected_mime_type,expected_size_bytes,storage_bucket,storage_object_key,upload_expires_at,mapping_version,row_count,valid_row_count,error_row_count,last_error_code")
          .eq("id", batchId).maybeSingle()] as const,
      );
      const { data, error } = batchResult;
      if (!error && data && typeof data.id === "string") {
        const refreshedBatch = data as ImportBatch;
        if (readGeneration !== readGenerationRef.current || !readController.isCurrent(readSequence)) return { batch: null, isCurrent: false };
        if (isDurableImportRowsVisibleStatus(data.status)) {
          const [rowResult] = await retrySupabaseQueriesAfterSessionRefresh(
            client,
            async () => [await client.from("import_rows")
              .select("row_number,proposed_action,validation_errors,import_field_diffs(field_name,old_value,new_value,confirmed)")
              .eq("batch_id", batchId).order("row_number").limit(10000)] as const,
          );
          if (readGeneration !== readGenerationRef.current || !readController.isCurrent(readSequence)) return { batch: null, isCurrent: false };
          if (!rowResult.error) setRows((rowResult.data ?? []) as unknown as ImportRow[]);
          if (!rowResult.error) setRowsLoadedForBatch(batchId);
          else setRowsLoadedForBatch(null);
        } else {
          setRows((currentRows) => currentRows.length === 0 ? currentRows : []);
          setRowsLoadedForBatch((currentBatchId) => currentBatchId === null ? currentBatchId : null);
        }
        if (readGeneration !== readGenerationRef.current || !readController.isCurrent(readSequence)) return { batch: null, isCurrent: false };
        setBatch(refreshedBatch);
        return { batch: refreshedBatch, isCurrent: true };
      }
      return { batch: null, isCurrent: readController.isCurrent(readSequence) };
    } finally {
      if (readController.isCurrent(readSequence)) setDataLoading(false);
    }
  }, [client, operationReady]);

  const refreshBatch = useCallback(async (batchId: string, showLoading = true): Promise<ImportBatch | null> => {
    return (await refreshBatchDetailed(batchId, showLoading)).batch;
  }, [refreshBatchDetailed]);

  const kickEdgeProcessor = useCallback(async (batchId: string, showError = false): Promise<boolean> => {
    if (!client || !batchId || edgeProcessingRef.current) return false;
    edgeProcessingRef.current = true;
    try {
      const { ok } = await kickImportWorkerUntilYielded(
        (options) => client.functions.invoke("import-worker", options),
        batchId,
      );
      if (!ok) {
        if (showError) setMessage("檔案已上傳，系統正在準備匯入；若畫面沒有變化，請按重新查詢批次。");
        return false;
      }
      return true;
    } catch {
      if (showError) setMessage("檔案已上傳，系統正在準備匯入；若畫面沒有變化，請按重新查詢批次。");
      return false;
    } finally {
      edgeProcessingRef.current = false;
    }
  }, [client]);

  useEffect(() => {
    if (!panelActive || !operationReady || !client) return;
    const recoveryClient = client;
    let active = true;
    async function recover() {
      setRecoveryLoading(true);
      try {
        const recoveryGeneration = readGenerationRef.current;
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
          const [batchResult] = await retrySupabaseQueriesAfterSessionRefresh(
            recoveryClient,
            async () => [await recoveryClient.from("import_batches")
              .select("id,batch_no,import_type,status,original_filename,expected_mime_type,expected_size_bytes,storage_bucket,storage_object_key,upload_expires_at,mapping_version,row_count,valid_row_count,error_row_count,last_error_code")
              .eq("id", saved.batchId).maybeSingle()] as const,
          );
          const { data } = batchResult;
          recoveredBatch = data as ImportBatch | null;
        } else {
          const { data } = await recoveryClient.rpc("get_import_upload_status", {
            p_import_type: saved.importType,
            p_idempotency_key: `IMPORT-UPLOAD-${saved.operationKey}`,
          });
          recoveredBatch = data as ImportBatch | null;
        }
        if (!active || recoveryGeneration !== readGenerationRef.current || !recoveredBatch || typeof recoveredBatch.id !== "string") return;
        const refreshedBatch = await refreshBatch(recoveredBatch.id);
        if (!active || recoveryGeneration !== readGenerationRef.current) return;
        const visibleBatch = refreshedBatch ?? recoveredBatch;
        if (!refreshedBatch) setBatch(visibleBatch);
        setMessage(`已恢復批次 ${visibleBatch.batch_no ?? "未知批次"}；重試會沿用原冪等鍵。若狀態需要上傳，請重新選同一檔案。`);
      } catch {
        recoveryRef.current = null;
      } finally {
        if (active) setRecoveryLoading(false);
      }
    }
    void recover();
    return () => { active = false; };
  }, [client, operationReady, panelActive, refreshBatch, recoveryStorageKey, visibleImportTypes]);

  useWorkflowStatusPoll<ImportBatch>({
    active: panelActive && operationReady && isDurableImportProcessingStatus(batch?.status),
    token: batch?.id ?? null,
    poll: async () => {
      if (!client || !batch?.id || !isDurableImportProcessingStatus(batch.status)) return null;
      await kickEdgeProcessor(batch.id);
      return refreshBatch(batch.id, false);
    },
    isTerminal: (value) => isDurableImportTerminalStatus(value.status) || value.status === "VALIDATED",
    onValue: (value) => {
      setBatch(value);
      if (value.status === "APPLIED") notifyInventoryDataChanged();
    },
    intervalMs: 2500,
  });

  function resetForNewFile(nextFile: File | null, isSample = false) {
    readGenerationRef.current += 1;
    readControllerRef.current?.invalidate();
    reloadSequenceRef.current += 1;
    setDataLoading(false);
    operationRef.current = null;
    cancelOperationRef.current = null;
    confirmOperationRef.current = null;
    setRows([]);
    setRowsLoadedForBatch(null);
    setDifferencesReviewed(false);
    setBatch(null);
    setFile(nextFile);
    setMessage("");
    setCancelFormOpen(false);
    setSampleMode(isSample);
    setSampleConfirmed(false);
    recoveryRef.current = null;
    if (typeof window !== "undefined") {
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
    if (nextFile && !isSample) void startUpload(nextFile, false, false);
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

  async function startUpload(uploadFile: File | null = file, uploadSampleMode = sampleMode, uploadSampleConfirmed = sampleConfirmed) {
    if (!operationReady || !client || !uploadFile) {
      setMessage(!client ? "預覽模式：設定 Supabase env 並登入後才能建立 durable batch。" : !operationReady ? "目前登入帳號尚未完成匯入權限查核，請重新整理後再試。" : "請先選擇 CSV 或 XLSX 檔案。");
      return;
    }
    if (uploadSampleMode && !uploadSampleConfirmed) {
      setMessage("上傳測試範例前，請先確認目前是 disposable staging 環境");
      return;
    }
    const mimeType = durableImportMimeForFilename(uploadFile.name);
    if (!mimeType) { setMessage("只接受 .csv 或 .xlsx；不接受 .xls、.xlsm 或其他格式。"); return; }
    if (uploadFile.size < 1 || uploadFile.size > 10_000_000) { setMessage("檔案大小必須介於 1 byte 與 10 MB。"); return; }
    setBusy(true); setMessage("");
    const operationKey = operationRef.current ?? crypto.randomUUID();
    operationRef.current = operationKey;
    persistRecovery({ operationKey, importType, fileName: uploadFile.name, sizeBytes: uploadFile.size });
    const ttlSeconds = 1800;
    const payload = durableImportFingerprintPayload({
      importType, filename: uploadFile.name, mimeType, sizeBytes: uploadFile.size,
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
      setMessage(safeSupabaseMutationErrorMessage(error, "建立上傳批次失敗或結果未知；請沿用同一檔案重試，不會另建批次。"));
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
    if (!isDurableImportAwaitingUpload(activeBatch.status)) {
      setMessage(`已查回批次 ${activeBatch.batch_no ?? "未知批次"}，目前狀態：${workflowStatusLabel(activeBatch.status)}`);
      setBusy(false); return;
    }
    let fileHash: string;
    try {
      fileHash = await sha256Hex(uploadFile);
    } catch (error) {
      setMessage("檔案雜湊計算失敗；請保留同一批次重試，不會另建批次。");
      setBusy(false);
      return;
    }
    const uploadResult = await client.storage.from(activeBatch.storage_bucket).upload(activeBatch.storage_object_key, uploadFile, {
      cacheControl: "3600",
      contentType: mimeType,
      upsert: false,
      metadata: { mimetype: mimeType, size: String(uploadFile.size), sha256: fileHash },
    });
    const objectAlreadyUploaded = isDurableImportObjectAlreadyUploaded(uploadResult.error);
    if (uploadResult.error && !objectAlreadyUploaded) {
      setMessage(safeSupabaseMutationErrorMessage(uploadResult.error, "檔案上傳結果尚未確認；請保留同一檔案與批次重試，不會另建批次。"));
    } else {
      const started = await kickEdgeProcessor(activeBatch.id, true);
      const refreshedAfterKick = await refreshBatch(activeBatch.id);
      const visibleAfterKick = refreshedAfterKick ?? activeBatch;
      setBatch(visibleAfterKick);
      if (refreshedAfterKick?.status === "APPLIED") notifyInventoryDataChanged();
      setMessage(refreshedAfterKick?.status === "VALIDATED"
        ? "檔案已檢查完成，請確認預覽內容後按「確認後匯入」。"
        : refreshedAfterKick?.status === "FAILED"
          ? "檔案檢查未通過，請依畫面提示修正後使用同一批次重試。"
          : started
            ? objectAlreadyUploaded
              ? `同一批次的檔案已存在，系統正在繼續檢查。批次：${activeBatch.batch_no ?? "未知批次"}`
              : `檔案已上傳，系統正在檢查。批次：${activeBatch.batch_no ?? "未知批次"}`
            : `檔案已上傳，系統正在檢查；若畫面沒有變化，請按重新查詢批次。批次：${activeBatch.batch_no ?? "未知批次"}`);
    }
    setBusy(false);
  }

  async function cancelBatch() {
    if (!operationReady || !client || !batch) {
      setMessage(!operationReady ? "目前登入帳號尚未完成匯入權限查核，請重新整理後再試。" : "目前沒有可取消的批次。" );
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
    if (error) setMessage(safeSupabaseMutationErrorMessage(error, "取消失敗或結果未知；請沿用同一批次重試。"));
    else { setBatch(data as ImportBatch); setMessage("批次已取消；固定 Storage object 會由受保護清理工作依引用與保存政策處理。"); cancelOperationRef.current = null; setCancelFormOpen(false); persistRecovery({ cancelKey: null }); }
    setBusy(false);
  }

  async function reloadBatch() {
    if (!operationReady || !client) {
      setMessage("目前登入帳號尚未完成匯入權限查核，請重新整理後再試。" );
      return;
    }
    if (!batch?.id) {
      setMessage("目前批次缺少有效識別碼，請重新整理頁面恢復批次。" );
      return;
    }
    const batchId = batch.id;
    const reloadSequence = ++reloadSequenceRef.current;
    await kickEdgeProcessor(batchId);
    if (reloadSequence !== reloadSequenceRef.current) return;
    const refreshedResult = await refreshBatchDetailed(batchId);
    if (reloadSequence !== reloadSequenceRef.current || !refreshedResult.isCurrent) return;
    const refreshedBatch = refreshedResult.batch;
    if (refreshedBatch?.status === "APPLIED") notifyInventoryDataChanged();
    setMessage(refreshedBatch ? `已重新查詢批次 ${refreshedBatch.batch_no}。` : "查不到目前批次，請確認登入帳號仍有匯入讀取權限。" );
  }

  async function confirmBatch() {
    if (!operationReady || !client || !batch || batch.status !== "VALIDATED") return;
    if (rowsLoadedForBatch !== batch.id) {
      setMessage("正在載入完整逐列差異，請稍候再確認發布。" );
      return;
    }
    if (previewSummary.unconfirmedDifferenceCount > 0 && !differencesReviewed) {
      setMessage(`請先勾選已檢查全部 ${previewSummary.unconfirmedDifferenceCount} 筆欄位差異，再確認發布。`);
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
    if (error) setMessage(safeSupabaseMutationErrorMessage(error, "確認匯入失敗或結果未知；請沿用同一按鈕重試。"));
    else {
      const confirmedBatch = data as ImportBatch;
      setBatch(confirmedBatch);
      const started = await kickEdgeProcessor(batch.id);
      const refreshedBatch = await refreshBatch(batch.id);
      setBatch(refreshedBatch ?? confirmedBatch);
      if (refreshedBatch?.status === "APPLIED") notifyInventoryDataChanged();
      setMessage(refreshedBatch?.status === "APPLIED"
        ? "匯入已完成。"
        : refreshedBatch?.status === "FAILED"
          ? "匯入未完成，請依畫面提示處理後使用同一按鈕重試。"
          : started
            ? "已確認，資料正在匯入。"
            : "已確認，系統正在準備匯入；請稍後按重新查詢批次。");
      confirmOperationRef.current = null;
      setDifferencesReviewed(false);
      persistRecovery({ confirmKey: null });
    }
    setBusy(false);
  }

  if (!client) return <section className="panel import-panel" aria-label="耐久匯入批次"><div className="panel-heading"><div><p className="eyebrow">06 / DURABLE IMPORT</p><h2>耐久匯入批次</h2></div><span className="status-pill">預覽模式</span></div><p className="auth-message">設定 Supabase env 並登入後，才能直傳固定 private Storage key；伺服器端 Edge Function 會完成解析與正式套用。</p></section>;
  const canChangeType = canChangeDurableImportType(busy || recoveryLoading, batch?.status);
  const fileInputDisabled = busy || recoveryLoading || Boolean(batch && !isDurableImportAwaitingUpload(batch.status)) || Boolean(batch && isDurableImportAwaitingUpload(batch.status) && file);
  const canCancel = batch && !isDurableImportTerminalStatus(batch.status);
  return <section className="panel import-panel" aria-label="耐久匯入批次" aria-busy={busy || dataLoading || recoveryLoading}>
    <div className="panel-heading"><div><p className="eyebrow">06 / DURABLE IMPORT</p><h2>檔案上傳與耐久匯入</h2></div><span className={`status-pill ${workflowStatusTone(batch?.status)}`}>{workflowStatusLabel(batch?.status)}</span></div>
     <p className="auth-message">選擇檔案後，系統會自動檢查資料；確認預覽內容後按「確認後匯入」即可完成匯入。檔案會直傳 private Storage，不會經過 Vercel request，瀏覽器也不持有 service-role 權限。</p>
    <div className="form-grid master-tools">
      <label className="field"><span>匯入類型</span><select value={importType} onChange={(event) => { if (!canChangeDurableImportType(busy || recoveryLoading, batch?.status)) return; resetForNewFile(null); setImportType(event.target.value as DurableImportType); }} disabled={!canChangeType}>{visibleImportTypes.map((type) => <option key={type} value={type}>{durableImportLabels[type]}</option>)}</select></label>
      <label className="file-picker"><span>選擇 CSV／XLSX</span><input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => selectFile(event.target.files?.[0] ?? null)} disabled={fileInputDisabled} /></label>
    </div>
    {batch && !canChangeType ? <p className="muted">目前批次仍在處理中；請先取消或完成目前批次，才能切換匯入類型。</p> : null}
    <div className="button-row"><button className="secondary-button" type="button" onClick={loadSampleFile} disabled={!canChangeType}>載入範例檔案</button><button className="secondary-button" type="button" onClick={downloadSampleFile} disabled={!canChangeType}>下載範例 CSV</button></div>
    {recoveryLoading ? <p className="auth-message" role="status" aria-live="polite">正在恢復上一筆匯入批次；完成後即可選擇檔案或切換匯入類型。</p> : dataLoading ? <p className="sr-only" role="status" aria-live="polite">正在讀取匯入批次與預覽資料…</p> : null}
    {sampleMode ? <label className="checkbox-field"><input type="checkbox" checked={sampleConfirmed} onChange={(event) => setSampleConfirmed(event.target.checked)} disabled={busy || recoveryLoading} />我確認這是 DEMO 測試資料，且目前連線的是 disposable staging</label> : null}
    {file ? <p className="file-name">{file.name}／{Math.ceil(file.size / 1024)} KB／{durableImportMimeForFilename(file.name)}</p> : null}
    <div className="button-row"><button className="primary-button" type="button" onClick={() => void startUpload()} disabled={busy || recoveryLoading || !file || Boolean(batch && !isDurableImportAwaitingUpload(batch.status))}>{busy ? "處理中…" : dataLoading ? "讀取中…" : batch ? "重試目前批次" : "上傳檔案"}</button>{batch?.status === "VALIDATED" ? <button className="primary-button" type="button" onClick={() => void confirmBatch()} disabled={busy || recoveryLoading || dataLoading || rowsLoadedForBatch !== batch.id}>確認後匯入</button> : null}{canCancel ? <button className="secondary-button" type="button" onClick={() => setCancelFormOpen((open) => !open)} disabled={busy || recoveryLoading}>{cancelFormOpen ? "收起取消" : "取消批次"}</button> : null}{batch && !isDurableImportTerminalStatus(batch.status) ? <button className="secondary-button" type="button" onClick={() => void reloadBatch()} disabled={busy || recoveryLoading}>重新查詢批次</button> : null}{batch && isDurableImportTerminalStatus(batch.status) ? <button className="secondary-button" type="button" onClick={startNewBatch} disabled={busy || recoveryLoading}>建立新批次</button> : null}</div>
    {canCancel && cancelFormOpen ? <div className="button-row"><label className="field"><span>取消理由（必填）</span><input value={cancelReason} onChange={(event) => { cancelOperationRef.current = null; setCancelReason(event.target.value); }} disabled={busy || recoveryLoading} /></label><button className="secondary-button" type="button" onClick={() => void cancelBatch()} disabled={busy || recoveryLoading || !cancelReason.trim()}>確認取消批次</button></div> : null}
     {batch ? <div className="summary-list"><p className="file-name">批次 {batch.batch_no ?? "未知批次"}／{workflowStatusLabel(batch.status)}／預期 {formatDurableImportCount(batch.expected_size_bytes)} bytes／期限 {formatDurableImportDate(batch.upload_expires_at)}</p><p className="muted">解析列數：{formatDurableImportCount(batch.row_count)}；有效：{formatDurableImportCount(batch.valid_row_count)}；錯誤：{formatDurableImportCount(batch.error_row_count)}</p>{batch.last_error_code ? <p className="auth-message">系統需要處理這個批次，請依畫面提示修正資料後重試。</p> : null}{previewSummary.validationErrorRows.map((row) => <p className="auth-message" key={`error-${row.row_number}`}>第 {row.row_number} 列資料需要修正，請依範例欄位格式檢查。</p>)}{previewSummary.visibleUnconfirmedDifferences.map((diff, index) => <p className="auth-message" key={`diff-${diff.field_name}-${index}`}>第 {index + 1} 筆資料有欄位差異，確認後才會匯入。</p>)}{batch.status === "VALIDATED" && rowsLoadedForBatch === batch.id && previewSummary.unconfirmedDifferenceCount > 0 ? <label className="checkbox-field"><input type="checkbox" checked={differencesReviewed} onChange={(event) => setDifferencesReviewed(event.target.checked)} disabled={busy} />我已檢查全部欄位差異，確認依預覽結果匯入（畫面列出前 10 筆，完整差異以後端逐列紀錄保存）</label> : null}</div> : null}
    {message ? <p className={message.startsWith("檔案已") || message.startsWith("批次已") ? "success-note" : "auth-message"} role="status">{message}</p> : null}
  </section>;
}
