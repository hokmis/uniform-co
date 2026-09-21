"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CorrectionHistoryTable from "@/src/app/CorrectionHistoryTable";
import type { CorrectionHistoryRow } from "@/src/domain/correction-history";
import { completeCorrectionOperation, correctionCompletionPlan, correctionPostRequestFingerprint } from "@/src/domain/correction-completion";
import { validateReturnCorrectionInput } from "@/src/domain/return-correction";
import type { AccountScopedReadOutcome } from "@/src/domain/account-scoped-read";
import { loadCorrectionHistory } from "@/src/lib/correction-history-read";
import { retrySupabaseQueriesAfterSessionRefresh, safeSupabaseMutationErrorMessage, safeSupabaseReadErrorMessage } from "@/src/lib/supabase-session";
import { notifyInventoryDataChanged } from "@/src/domain/inventory-events";
import { workflowStatusLabel, workflowStatusTone } from "@/src/domain/workflow-status";
import { usePanelActivity } from "./RetainedPanelSet";
import { useWorkspaceSession } from "./workspace-session";
import { useAccountScopedReadSnapshot } from "./use-account-scoped-read-snapshot";
import WorkflowActionBar from "./WorkflowActionBar";

type ReturnLine = { id: string; return_note_id: string; return_no: string; original_issue_line_id: string; employee_no_snapshot: string | null; employee_name_snapshot: string | null; item_code_snapshot: string | null; item_name_snapshot: string | null; quantity: number; unit_snapshot: string | null };
type Correction = { id: string; correction_no: string; status: "DRAFT" | "POSTED"; original_return_note_id: string };
type History = { id: string; correction_no: string; status: string; reason: string; delta: number; posted_at: string | null };

const STORAGE_PREFIX = "uniform:return-correction";
const EMPTY_RETURN_LINES: ReturnLine[] = [];

export default function ReturnCorrectionPanel() {
  const { client, isAuthenticated, accountId, identityError, identityLoading } = useWorkspaceSession();
  const panelActive = usePanelActivity();
  const hasSession = isAuthenticated;
  const identityReady = Boolean(client && panelActive && hasSession && accountId && !identityLoading && !identityError);
  const [lineId, setLineId] = useState("");
  const [correctionNo, setCorrectionNo] = useState("");
  const [delta, setDelta] = useState(0);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [correction, setCorrection] = useState<Correction | null>(null);
  const [history, setHistory] = useState<History[]>([]);
  const [busy, setBusy] = useState(false);
  const [completionUnresolved, setCompletionUnresolved] = useState(true);
  const createKeyRef = useRef<string | null>(null);
  const postKeyRef = useRef<string | null>(null);
  const recoveredLineIdRef = useRef<string | null>(null);
  const readReturnLines = useCallback(async (): Promise<AccountScopedReadOutcome<ReturnLine[]>> => {
    if (!client) return { status: "failure", errors: [], message: "已完成退回明細尚未連線。請登入後重試。" };
    const [result] = await retrySupabaseQueriesAfterSessionRefresh(
      client,
      async () => [await client.from("v_return_correction_sources")
        .select("line_id,return_id,return_no,original_issue_line_id,employee_no_snapshot,employee_name_snapshot,item_code,item_name,quantity,unit_snapshot")
        .order("return_no", { ascending: false })
        .order("line_id", { ascending: true })] as const,
    );
    if (result.error) {
      return { status: "failure", errors: [result.error], message: `已完成退回明細載入失敗：${safeSupabaseReadErrorMessage(result.error)}` };
    }
    const sourceRows = (result.data ?? []) as Array<{
      line_id: string;
      return_id: string;
      return_no: string;
      original_issue_line_id: string;
      employee_no_snapshot: string | null;
      employee_name_snapshot: string | null;
      item_code: string | null;
      item_name: string | null;
      quantity: number;
      unit_snapshot: string | null;
    }>;
    return {
      status: "success",
      data: sourceRows.map((row) => ({
        id: row.line_id,
        return_note_id: row.return_id,
        return_no: row.return_no,
        original_issue_line_id: row.original_issue_line_id,
        employee_no_snapshot: row.employee_no_snapshot,
        employee_name_snapshot: row.employee_name_snapshot,
        item_code_snapshot: row.item_code,
        item_name_snapshot: row.item_name,
        quantity: row.quantity,
        unit_snapshot: row.unit_snapshot,
      })),
      message: `已載入 ${sourceRows.length} 筆可更正的退回明細。`,
    };
  }, [client]);
  const {
    data: lines,
    hasCurrentSnapshot: sourceSnapshotReady,
    loading: dataLoading,
    message,
    setMessage,
  } = useAccountScopedReadSnapshot({
    accountId: accountId ?? null,
    enabled: identityReady,
    refreshKey: 0,
    emptyData: EMPTY_RETURN_LINES,
    resourceLabel: "已完成退回明細",
    initialMessage: client ? "正在確認身份並載入可更正的退回明細…" : "設定 Supabase 並登入後，才能讀取可更正的退回明細。",
    read: readReturnLines,
  });
  const selectedLine = useMemo(() => lines.find((line) => line.id === lineId), [lines, lineId]);
  const validationError = validateReturnCorrectionInput({ returnQuantityDelta: delta, reason });
  const historyRows: CorrectionHistoryRow[] = useMemo(() => history.map((row) => ({
    id: row.id,
    correctionNo: row.correction_no,
    status: row.status,
    reason: row.reason,
    deltaText: String(row.delta),
    postedAt: row.posted_at,
  })), [history]);

  useEffect(() => {
    if (!sourceSnapshotReady) return;
    const recovered = recoveredLineIdRef.current;
    setLineId((current) => {
      if (recovered && lines.some((line) => line.id === recovered)) return recovered;
      return lines.some((line) => line.id === current) ? current : "";
    });
  }, [lines, sourceSnapshotReady]);

  useEffect(() => {
    if (!identityReady || !client) return;
    const supabase = client;
    const savedCreateKey = window.localStorage.getItem(`${STORAGE_PREFIX}:create-key`);
    const savedPostKey = window.localStorage.getItem(`${STORAGE_PREFIX}:post-key`);
    const savedId = window.localStorage.getItem(`${STORAGE_PREFIX}:id`);
    if (savedCreateKey) createKeyRef.current = savedCreateKey;
    if (savedPostKey) postKeyRef.current = savedPostKey;
    let active = true;
    async function recover() {
      if (!savedCreateKey && !savedPostKey && !savedId) { setCompletionUnresolved(false); return; }
      const [statusResult] = await retrySupabaseQueriesAfterSessionRefresh(
        supabase,
        async () => [await supabase.rpc("get_return_correction_status", {
          p_correction_note_id: savedId,
          p_create_idempotency_key: savedCreateKey ? `CREATE-RETURN-CORRECTION-${savedCreateKey}` : null,
          p_post_idempotency_key: savedPostKey ? `POST-RETURN-CORRECTION-${savedPostKey}` : null,
        })] as const,
      );
      if (!active) return;
      if (statusResult.error) { setMessage(`退回更正結果尚未確認：${safeSupabaseReadErrorMessage(statusResult.error)}`); setCompletionUnresolved(true); return; }
      if (statusResult.data?.id) {
        setCompletionUnresolved(false);
        setCorrection(statusResult.data as Correction);
        window.localStorage.setItem(`${STORAGE_PREFIX}:id`, String(statusResult.data.id));
        const [sourceResult] = await retrySupabaseQueriesAfterSessionRefresh(
          supabase,
          async () => [await supabase.from("return_correction_lines")
            .select("original_return_line_id").eq("correction_note_id", statusResult.data.id).maybeSingle()] as const,
        );
        if (sourceResult.data?.original_return_line_id) {
          recoveredLineIdRef.current = String(sourceResult.data.original_return_line_id);
          if (active) setLineId(String(sourceResult.data.original_return_line_id));
        }
        setMessage("已恢復上一筆退回更正操作；請確認狀態後繼續。");
      } else {
        createKeyRef.current = null; postKeyRef.current = null;
        window.localStorage.removeItem(`${STORAGE_PREFIX}:create-key`);
        window.localStorage.removeItem(`${STORAGE_PREFIX}:post-key`);
        window.localStorage.removeItem(`${STORAGE_PREFIX}:post-fingerprint`);
        window.localStorage.removeItem(`${STORAGE_PREFIX}:id`);
        setCompletionUnresolved(false);
        setMessage("查無尚未完成的退回更正；已解除暫鎖，請重新選擇來源並填寫資料。");
      }
    }
    void recover();
    return () => { active = false; };
  }, [client, identityReady, setMessage]);

  useEffect(() => {
    if (!identityReady || !client || !selectedLine) return;
    const supabase = client;
    const sourceLine = selectedLine;
    let active = true;
    async function loadHistory() {
      const result = await loadCorrectionHistory(supabase, { kind: "RETURN", parentId: sourceLine.return_note_id, lineId: sourceLine.id });
      if (!active) return;
      if (result.error) { setMessage("退回更正歷史載入失敗，請重新整理後再試。"); return; }
      setHistory(result.data.map((row) => ({ id: row.id, correction_no: row.correction_no, status: row.status, reason: row.reason, delta: row.delta, posted_at: row.posted_at })));
    }
    void loadHistory();
    return () => { active = false; };
  }, [client, identityReady, selectedLine, setMessage]);

  function resetKeys() {
    setCompletionUnresolved(false);
    createKeyRef.current = null; postKeyRef.current = null;
    window.localStorage.removeItem(`${STORAGE_PREFIX}:create-key`);
    window.localStorage.removeItem(`${STORAGE_PREFIX}:post-key`);
    window.localStorage.removeItem(`${STORAGE_PREFIX}:post-fingerprint`);
  }
  function chooseLine(nextId: string) {
    if (correction) return;
    recoveredLineIdRef.current = null;
    resetKeys(); window.localStorage.removeItem(`${STORAGE_PREFIX}:id`);
    setLineId(nextId); setDelta(0); setReason(""); setNote("");
  }
  async function createDraft(keepBusy = false): Promise<Correction | null> {
    if (!client || !selectedLine || !correctionNo.trim() || validationError) {
      setMessage(validationError ?? "請選擇已完成的退回明細、填寫單號與原因。"); return null;
    }
    setBusy(true); setMessage("");
    const key = createKeyRef.current ?? crypto.randomUUID(); createKeyRef.current = key;
    window.localStorage.setItem(`${STORAGE_PREFIX}:create-key`, key);
    const payload = { lineId: selectedLine.id, correctionNo: correctionNo.trim(), delta, reason: reason.trim(), note: note.trim() };
    const { data, error } = await client.rpc("create_return_correction_draft", {
      p_correction_no: correctionNo.trim(), p_original_return_line_id: selectedLine.id,
      p_return_quantity_delta: delta, p_reason: reason.trim(), p_note: note.trim() || null,
      p_idempotency_key: `CREATE-RETURN-CORRECTION-${key}`, p_request_fingerprint: JSON.stringify(payload),
    });
    if (error || !data?.id) {
      setMessage(safeSupabaseMutationErrorMessage(error, "退回更正結果尚未確認；請使用相同操作重試。"));
      if (!keepBusy) setBusy(false);
      return null;
    }
    const created = data as Correction;
    setCorrection(created); createKeyRef.current = null;
    window.localStorage.removeItem(`${STORAGE_PREFIX}:create-key`); window.localStorage.setItem(`${STORAGE_PREFIX}:id`, created.id);
    setMessage("退回更正草稿已建立；確認後送出。");
    if (!keepBusy) setBusy(false);
    return created;
  }
  async function postCorrection(correctionToPost: Correction | null = correction): Promise<boolean> {
    if (!client || !correctionToPost || correctionToPost.status !== "DRAFT") return false;
    setBusy(true); setMessage("");
    const key = postKeyRef.current ?? crypto.randomUUID(); postKeyRef.current = key;
    window.localStorage.setItem(`${STORAGE_PREFIX}:post-key`, key);
    const idempotencyKey = `POST-RETURN-CORRECTION-${key}`;
    const requestFingerprint = window.localStorage.getItem(`${STORAGE_PREFIX}:post-fingerprint`)
      ?? JSON.stringify({ correctionId: correctionToPost.id, correctionNo: correctionToPost.correction_no });
    const { data, error } = await client.rpc("post_return_correction", {
      p_correction_note_id: correctionToPost.id, p_idempotency_key: idempotencyKey,
      p_request_fingerprint: requestFingerprint,
    });
    if (error || !data?.id) {
      setMessage(safeSupabaseMutationErrorMessage(error, "退回更正結果尚未確認；請使用相同操作重試。"));
      setBusy(false);
      return false;
    }
    const posted = data as Correction; setCorrection(posted); postKeyRef.current = null;
    window.localStorage.removeItem(`${STORAGE_PREFIX}:post-key`); window.localStorage.removeItem(`${STORAGE_PREFIX}:post-fingerprint`); window.localStorage.setItem(`${STORAGE_PREFIX}:id`, posted.id);
    notifyInventoryDataChanged();
    setMessage("退回更正已完成；有效退回量與人資倉庫存已在同一交易重算。");
    setCompletionUnresolved(false);
    setBusy(false);
    return true;
  }
  async function completeCorrection() {
    if (correction) {
      await postCorrection(correction);
      return;
    }
    if (!client || !selectedLine || !correctionNo.trim() || validationError) return;
    setBusy(true); setMessage("");
    const createKey = createKeyRef.current ?? crypto.randomUUID();
    const postKey = postKeyRef.current ?? crypto.randomUUID();
    createKeyRef.current = createKey; postKeyRef.current = postKey;
    window.localStorage.setItem(`${STORAGE_PREFIX}:create-key`, createKey);
    window.localStorage.setItem(`${STORAGE_PREFIX}:post-key`, postKey);
    const payload = { lineId: selectedLine.id, correctionNo: correctionNo.trim(), delta, reason: reason.trim(), note: note.trim() };
    const createIdempotencyKey = `CREATE-RETURN-CORRECTION-${createKey}`;
    const createRequestFingerprint = JSON.stringify(payload);
    const postIdempotencyKey = `POST-RETURN-CORRECTION-${postKey}`;
    const postRequestFingerprint = correctionPostRequestFingerprint("POST_RETURN_CORRECTION", postIdempotencyKey);
    window.localStorage.setItem(`${STORAGE_PREFIX}:post-fingerprint`, postRequestFingerprint);
    const createArgs = {
      p_correction_no: correctionNo.trim(), p_original_return_line_id: selectedLine.id,
      p_return_quantity_delta: delta, p_reason: reason.trim(), p_note: note.trim() || null,
      p_idempotency_key: createIdempotencyKey, p_request_fingerprint: createRequestFingerprint,
    };
    const completionPlan = correctionCompletionPlan({
      atomicFunctionName: "complete_return_correction",
      createFunctionName: "create_return_correction_draft",
      createArgs,
      postFunctionName: "post_return_correction",
      postIdempotencyKey,
      postRequestFingerprint,
      postArgs: (correctionId) => ({
        p_correction_note_id: correctionId, p_idempotency_key: postIdempotencyKey,
        p_request_fingerprint: postRequestFingerprint,
      }),
    });
    const result = await completeCorrectionOperation((functionName, args) => client.rpc(functionName, args), client, completionPlan);
    if (result.correction?.status === "POSTED") {
      setCorrection(result.correction as Correction); createKeyRef.current = null; postKeyRef.current = null;
      window.localStorage.removeItem(`${STORAGE_PREFIX}:create-key`); window.localStorage.removeItem(`${STORAGE_PREFIX}:post-key`); window.localStorage.removeItem(`${STORAGE_PREFIX}:post-fingerprint`);
      window.localStorage.setItem(`${STORAGE_PREFIX}:id`, result.correction.id);
      setCompletionUnresolved(false); notifyInventoryDataChanged();
      setMessage("退回更正已完成；有效退回量與人資倉庫存已在同一交易重算。");
    } else if (result.correction?.status === "DRAFT") {
      setCorrection(result.correction as Correction); createKeyRef.current = null;
      window.localStorage.removeItem(`${STORAGE_PREFIX}:create-key`); window.localStorage.setItem(`${STORAGE_PREFIX}:id`, result.correction.id);
      setCompletionUnresolved(false);
      setMessage(result.error
        ? safeSupabaseMutationErrorMessage(result.error, "退回更正草稿已建立，完成結果尚未確認；請重試同一筆。")
        : "退回更正草稿已建立，完成結果尚未確認；請重試同一筆。");
    } else if (result.outcomeUnknown) {
      setCompletionUnresolved(true);
      setMessage("退回更正結果尚未確認；欄位已暫時鎖定，請按「重試同一筆」查回。");
    } else {
      createKeyRef.current = null; postKeyRef.current = null;
      window.localStorage.removeItem(`${STORAGE_PREFIX}:create-key`); window.localStorage.removeItem(`${STORAGE_PREFIX}:post-key`); window.localStorage.removeItem(`${STORAGE_PREFIX}:post-fingerprint`);
      setCompletionUnresolved(false);
      setMessage(safeSupabaseMutationErrorMessage(result.error, "退回更正建立或完成失敗；請檢查資料後重試。"));
    }
    setBusy(false);
  }
  function startAnother() {
    recoveredLineIdRef.current = null;
    resetKeys(); window.localStorage.removeItem(`${STORAGE_PREFIX}:id`); setLineId("");
    setCorrection(null); setCorrectionNo(""); setDelta(0); setReason(""); setNote("");
    setMessage("可建立下一筆退回更正。");
  }

  if (!client) return <section className="panel import-panel" aria-label="退回更正"><div className="panel-heading"><div><p className="eyebrow">10 / RETURN CORRECTION</p><h2>退回更正</h2></div><span className="status-pill">預覽模式</span></div><p className="auth-message">登入 HR 帳號後，可針對已完成的退回明細建立更正。</p></section>;
  const effectiveReturned = (selectedLine?.quantity ?? 0) + history.filter((row) => row.status === "POSTED").reduce((sum, row) => sum + row.delta, 0);
  const sourceReadBlocked = dataLoading && !sourceSnapshotReady;
  return <section className="panel import-panel" aria-label="退回更正" aria-busy={busy || dataLoading}>
    <div className="panel-heading"><div><p className="eyebrow">10 / RETURN CORRECTION</p><h2>退回更正</h2></div><span className={`status-pill ${workflowStatusTone(correction?.status)}`}>{completionUnresolved ? "結果待確認" : workflowStatusLabel(correction?.status)}</span></div>
    <p className="auth-message">更正不覆寫原退回單；送出時會鎖定原退回單與原發放明細，重算有效退回量，並以本次差額調整人資倉。</p>
    <div className="form-grid">
      <label className="field"><span>原始退回明細</span><select value={lineId} onChange={(event) => chooseLine(event.target.value)} disabled={busy || completionUnresolved || sourceReadBlocked || Boolean(correction)}><option value="">{sourceReadBlocked ? "載入退回明細中…" : "請選擇"}</option>{lines.map((line) => <option key={line.id} value={line.id}>{line.return_no}｜{line.employee_no_snapshot}｜{line.item_code_snapshot}｜原退回 {line.quantity}</option>)}</select></label>
      <div className="metric"><span>目前有效退回量</span><strong>{selectedLine ? effectiveReturned : "—"}</strong><small>{selectedLine?.item_name_snapshot ?? "請先選擇明細"}</small></div>
      <label className="field"><span>更正單號</span><input value={correctionNo} onChange={(event) => { resetKeys(); setCorrectionNo(event.target.value); }} maxLength={80} disabled={busy || completionUnresolved || Boolean(correction)} placeholder="例如 RTC-RET-2026-001" /></label>
      <label className="field"><span>退回量差額</span><input type="number" step={1} value={delta} onChange={(event) => { resetKeys(); setDelta(Number(event.target.value) || 0); }} disabled={busy || completionUnresolved || Boolean(correction)} /></label>
    </div>
    <label className="field reason-field"><span>更正原因</span><input value={reason} onChange={(event) => { resetKeys(); setReason(event.target.value); }} maxLength={1000} disabled={busy || completionUnresolved || Boolean(correction)} placeholder="例如：退回數量誤登" /></label>
    <label className="field reason-field"><span>備註（選填）</span><input value={note} onChange={(event) => { resetKeys(); setNote(event.target.value); }} maxLength={2000} disabled={busy || completionUnresolved || Boolean(correction)} /></label>
    {dataLoading ? <p className="sr-only" role="status" aria-live="polite">正在讀取可更正的退回明細…</p> : null}
    {validationError ? <p className="auth-message">{validationError}</p> : null}
    <CorrectionHistoryTable ariaLabel="退回更正歷史" rows={historyRows} deltaLabel="退回量差額" />
    <WorkflowActionBar
      primary={{
        onClick: () => void completeCorrection(),
        busy,
        busyLabel: "處理中…",
        disabled: busy || sourceReadBlocked || !selectedLine || !correctionNo.trim() || Boolean(validationError) || correction?.status === "POSTED",
        label: correction?.status === "POSTED" ? "已完成" : completionUnresolved ? "重試同一筆（結果待確認）" : "確認並完成退回更正",
      }}
      secondary={!correction
        ? <button className="secondary-button" type="button" onClick={() => void createDraft()} disabled={busy || completionUnresolved || sourceReadBlocked || !selectedLine}>{busy ? "建立中…" : sourceReadBlocked ? "載入來源中…" : "先建立退回更正草稿"}</button>
        : <button className="secondary-button" type="button" onClick={startAnother} disabled={busy}>建立另一筆更正</button>}
    />
    {correction ? <p className="success-note">更正單 {correction.correction_no}／{workflowStatusLabel(correction.status)}。{correction.status === "DRAFT" ? "請確認數量與理由後即可送出。" : "更正已鎖定。"}</p> : null}
    {message ? <p className={message.includes("已") ? "success-note" : "auth-message"} role="status">{message}</p> : null}
  </section>;
}
