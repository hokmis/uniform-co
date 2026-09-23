"use client";

import { useEffect, useRef, useState } from "react";
import { parseEmployeeCsv, type EmployeeImportResult } from "@/src/domain/employee-import";
import { masterRowsToCsv } from "@/src/domain/master-data";
import { sampleEmployeeRows } from "@/src/domain/master-data-samples";
import { invalidateMasterDataCache } from "@/src/lib/master-data-cache";
import { invalidateEmployeeDirectory, loadEmployeeDirectory } from "@/src/lib/employee-directory-read";
import { retrySupabaseQueriesAfterSessionRefresh, safeSupabaseMutationErrorMessage, safeSupabaseReadErrorMessage } from "@/src/lib/supabase-session";
import { usePanelActivity } from "./RetainedPanelSet";
import { useWorkspaceSession } from "./workspace-session";

export default function EmployeeImportPanel() {
  const panelActive = usePanelActivity();
  const { client, isAuthenticated, accountId, identityError, identityLoading } = useWorkspaceSession();
  const hasSession = isAuthenticated;
  const identityReady = Boolean(client && panelActive && hasSession && accountId && !identityLoading && !identityError);
  const [result, setResult] = useState<EmployeeImportResult | null>(null);
  const [fileName, setFileName] = useState("");
  const [message, setMessage] = useState("");
  const [backendErrors, setBackendErrors] = useState<Array<{ row_number: number; error_code: string | null; error_message: string | null }>>([]);
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState(false);
  const [sampleMode, setSampleMode] = useState(false);
  const [sampleConfirmed, setSampleConfirmed] = useState(false);
  const [hasOperation, setHasOperation] = useState(false);
  const [existingEmployees, setExistingEmployees] = useState<Map<string, { name: string; institutionCode: string; departmentCode: string; employmentStatus: string }>>(new Map());
  const operationRef = useRef<{ key: string; fingerprint: string } | null>(null);
  const displayMessage = identityError ?? message;

  useEffect(() => {
    if (!identityReady || !client) return;
    const activeSupabase = client;
    let active = true;
    async function loadExisting() {
      const directoryResult = await loadEmployeeDirectory(activeSupabase);
      if (!active || directoryResult.errors.length > 0) return;
      setExistingEmployees(new Map(directoryResult.employees.map((row) => [row.employee_no, {
        name: row.name,
        institutionCode: row.institution_code ?? "",
        departmentCode: row.department_code ?? "",
        employmentStatus: row.employment_status,
      }])));
    }
    void loadExisting();
    return () => { active = false; };
  }, [client, identityReady, panelActive]);

  function previewText(sourceName: string, text: string, isSample = false) {
    setFileName(sourceName);
    setApplied(false);
    setMessage("");
    setBackendErrors([]);
    operationRef.current = null;
    setHasOperation(false);
    setSampleMode(isSample);
    setSampleConfirmed(false);
    setResult(parseEmployeeCsv(text));
  }

  async function handleFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 10_000_000) {
      previewText(file.name, "");
      setResult({ headers: [], rows: [], errors: [{ row: 1, code: "INVALID_COLUMN_COUNT", message: "檔案超過 10 MB 上限" }] });
      setMessage("");
      return;
    }
    try {
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
      previewText(file.name, text);
    } catch {
      previewText(file.name, "");
      setResult({ headers: [], rows: [], errors: [{ row: 1, code: "MALFORMED_CSV", message: "無法讀取所選 CSV 檔案" }] });
      setMessage("");
    }
  }

  function loadSamplePreview() {
    previewText("sample-employees.csv", masterRowsToCsv(sampleEmployeeRows), true);
    setMessage(`已載入 ${sampleEmployeeRows.length} 列測試範例；請只在 disposable staging 使用`);
  }

  function downloadSample() {
    const blob = new Blob([masterRowsToCsv(sampleEmployeeRows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "sample-employees.csv";
    anchor.click();
    URL.revokeObjectURL(url);
    setMessage("測試員工 CSV 已下載；請只在 disposable staging 使用");
  }

  async function applyImport() {
    if (!result || result.errors.length > 0 || result.rows.length === 0) return;
    if (sampleMode && !sampleConfirmed) {
      setMessage("套用測試範例前，請先確認目前是 disposable staging 環境");
      return;
    }
    if (!identityReady || !client) {
      setMessage(identityError ?? "正在確認工作區身份，確認完成後才能原子套用。");
      return;
    }
    setBusy(true);
    try {
      const operation = operationRef.current ?? { key: crypto.randomUUID(), fingerprint: "" };
      operation.fingerprint = JSON.stringify(result.rows);
      operationRef.current = operation;
      setHasOperation(true);
      const { data, error } = await client.rpc("apply_employee_import_checked", {
        p_source_filename: fileName,
        p_rows: result.rows,
        p_idempotency_key: `EMP-IMPORT-${operation.key}`,
        p_request_fingerprint: operation.fingerprint,
      });
      if (error) {
        setMessage(safeSupabaseMutationErrorMessage(error, "匯入結果未知或失敗；再次確認會沿用相同冪等鍵。"));
      } else if (data?.status === "APPLIED") {
        invalidateEmployeeDirectory(client);
        invalidateMasterDataCache(client, "employee");
        setApplied(true);
        setMessage(`已原子套用 ${data.row_count ?? result.rows.length} 列員工主檔。`);
      } else if (data?.status === "FAILED" && data?.id) {
        const [rowsResult] = await retrySupabaseQueriesAfterSessionRefresh(
          client,
          async () => [await client.from("employee_import_rows").select("row_number,error_code,error_message").eq("batch_id", data.id).eq("status", "ERROR").order("row_number")] as const,
        );
        if (rowsResult.error) {
          setMessage(safeSupabaseReadErrorMessage(rowsResult.error));
          setHasOperation(false);
          operationRef.current = null;
          return;
        }
        setBackendErrors((rowsResult.data ?? []) as Array<{ row_number: number; error_code: string | null; error_message: string | null }>);
        setHasOperation(false);
        operationRef.current = null;
        setMessage(`整批拒絕：${data.error_count ?? ""} 列需要修正；請修正 CSV 後重新選檔。`);
      } else {
        setMessage("批次尚未完成，請檢查逐列錯誤或使用相同檔案重試。相同操作不會重複建立批次。");
      }
    } catch {
      setMessage("匯入結果未知或逐列結果載入失敗；再次確認會沿用相同冪等鍵。");
    } finally {
      setBusy(false);
    }
  }

  const diffSummary = result ? result.rows.reduce((summary, row) => {
    const current = existingEmployees.get(row.employeeNo);
    if (!current) return { ...summary, added: summary.added + 1 };
    const changed = current.name !== row.name || current.institutionCode !== row.institutionCode || current.departmentCode !== row.departmentCode || current.employmentStatus !== row.employmentStatus;
    return changed ? { ...summary, changed: summary.changed + 1 } : { ...summary, unchanged: summary.unchanged + 1 };
  }, { added: 0, changed: 0, unchanged: 0 }) : null;

  return (
    <section className="panel import-panel" aria-label="員工 CSV 匯入預覽">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">05 / MASTER DATA</p>
          <h2>員工 CSV 匯入預覽</h2>
        </div>
        <span className={`status-pill ${result && result.errors.length > 0 ? "danger" : applied ? "success" : ""}`}>
          {result ? (result.errors.length > 0 ? "需修正" : applied ? "已套用" : "可確認預覽") : "尚未選檔"}
        </span>
      </div>
      <p className="auth-message">
        CSV 先在瀏覽器預覽，再由受保護的 atomic import RPC 驗證整批並套用；缺部門或重複工號不會寫入正式主檔。
      </p>
      <label
        htmlFor="employee-import-file-picker"
        className="file-picker"
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const droppedFile = e.dataTransfer.files?.[0];
          if (droppedFile) void handleFile(droppedFile);
        }}
      >
        <span>選擇 CSV（或拖曳檔案至此）</span>
      </label>
      <input
        id="employee-import-file-picker"
        type="file"
        accept=".csv,text/csv"
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
      <div className="button-row">
        <button className="secondary-button" type="button" disabled={busy} onClick={loadSamplePreview}>載入範例到預覽</button>
        <button className="secondary-button" type="button" disabled={busy} onClick={downloadSample}>下載範例 CSV</button>
      </div>
      {sampleMode ? <label className="checkbox-field"><input type="checkbox" checked={sampleConfirmed} onChange={(event) => setSampleConfirmed(event.target.checked)} disabled={busy} />我確認這是 DEMO 測試資料，且目前連線的是 disposable staging</label> : null}
      {fileName ? <p className="file-name">{fileName}</p> : null}
      {result ? (
        <div className="import-result">
          <div className="import-metrics">
            <Metric label="可預覽列數" value={result.rows.length} />
            <Metric label="錯誤數" value={result.errors.length} />
            {diffSummary ? <><Metric label="新增工號" value={diffSummary.added} /><Metric label="既有變更" value={diffSummary.changed} /><Metric label="既有不變" value={diffSummary.unchanged} /></> : null}
          </div>
          {result.errors.length > 0 ? (
            <ul className="import-errors">
              {result.errors.slice(0, 8).map((error, index) => (
                <li key={`${error.row}-${error.code}-${index}`}>
                  第 {error.row} 列：{error.message}
                </li>
              ))}
            </ul>
          ) : (
            <>
              <p className="success-note">預覽通過；確認後會保留原始檔名、逐列結果與套用批次。</p>
              <button className="primary-button" type="button" onClick={() => void applyImport()} disabled={busy || !identityReady || applied || (sampleMode && !sampleConfirmed)}>{busy ? "套用中…" : applied ? "已套用" : hasOperation ? "重試套用（沿用冪等鍵）" : "確認並套用整批"}</button>
            </>
          )}
          {backendErrors.length > 0 ? <ul className="import-errors">{backendErrors.map((error) => <li key={`${error.row_number}-${error.error_code}`}>第 {error.row_number} 列：資料未通過伺服器驗證，請依範例格式修正。</li>)}</ul> : null}
        </div>
      ) : null}
      {displayMessage ? <p className={displayMessage.startsWith("已") ? "success-note" : "auth-message"} role="status">{displayMessage}</p> : null}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
