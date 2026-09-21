"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CorrectionHistoryTable from "@/src/app/CorrectionHistoryTable";
import type { CorrectionHistoryRow } from "@/src/domain/correction-history";
import { completeCorrectionOperation, correctionCompletionPlan, correctionPostRequestFingerprint } from "@/src/domain/correction-completion";
import type { AccountScopedReadOutcome } from "@/src/domain/account-scoped-read";
import { retrySupabaseQueriesAfterSessionRefresh, safeSupabaseMutationErrorMessage, safeSupabaseReadErrorMessage } from "@/src/lib/supabase-session";
import { notifyInventoryDataChanged } from "@/src/domain/inventory-events";
import { validateReceiptCorrectionInput } from "@/src/domain/receipt-correction";
import { loadCorrectionHistory } from "@/src/lib/correction-history-read";
import { workflowStatusLabel, workflowStatusTone } from "@/src/domain/workflow-status";
import { usePanelActivity } from "./RetainedPanelSet";
import { useWorkspaceSession } from "./workspace-session";
import { useAccountScopedReadSnapshot } from "./use-account-scoped-read-snapshot";
import WorkflowActionBar from "./WorkflowActionBar";

type Receipt = { id: string; receipt_no: string; purchase_order_id: string; received_on: string };
type ReceiptLine = { id: string; receipt_id: string; receipt_no: string; purchase_order_id: string; received_on: string; item_code_snapshot: string; item_name_snapshot: string; delivered_quantity: number; accepted_quantity: number; rejected_quantity: number };
type Correction = { id: string; correction_no: string; status: "DRAFT" | "POSTED"; original_purchase_receipt_id: string };
type CorrectionHistory = { id: string; correction_no: string; status: string; reason: string; delivered_quantity_delta: number; accepted_quantity_delta: number; rejected_quantity_delta: number; posted_at: string | null };

const STORAGE_PREFIX = "uniform:receipt-correction";
const EMPTY_RECEIPT_LINES: ReceiptLine[] = [];

export default function PurchaseReceiptCorrectionPanel() {
  const { client, isAuthenticated, accountId, identityError, identityLoading } = useWorkspaceSession();
  const panelActive = usePanelActivity();
  const hasSession = isAuthenticated;
  const identityReady = Boolean(client && panelActive && hasSession && accountId && !identityLoading && !identityError);
  const [lineId, setLineId] = useState("");
  const [correctionNo, setCorrectionNo] = useState("");
  const [reason, setReason] = useState("");
  const [deliveredDelta, setDeliveredDelta] = useState(0);
  const [acceptedDelta, setAcceptedDelta] = useState(0);
  const [rejectedDelta, setRejectedDelta] = useState(0);
  const [rejectionReason, setRejectionReason] = useState("");
  const [correction, setCorrection] = useState<Correction | null>(null);
  const [history, setHistory] = useState<CorrectionHistory[]>([]);
  const [busy, setBusy] = useState(false);
  const [completionUnresolved, setCompletionUnresolved] = useState(true);
  const createKeyRef = useRef<string | null>(null);
  const postKeyRef = useRef<string | null>(null);
  const recoveredLineIdRef = useRef<string | null>(null);
  const readReceiptLines = useCallback(async (): Promise<AccountScopedReadOutcome<ReceiptLine[]>> => {
    if (!client) return { status: "failure", errors: [], message: "已完成入庫明細尚未連線。請登入後重試。" };
    const [sourceResult] = await retrySupabaseQueriesAfterSessionRefresh(
      client,
      async () => [await client.from("v_purchase_receipt_correction_sources")
        .select("line_id,receipt_id,receipt_no,purchase_order_id,received_on,item_code,item_name,delivered_quantity,accepted_quantity,rejected_quantity")
        .order("receipt_no", { ascending: false })
        .order("line_id", { ascending: true })] as const,
    );
    if (sourceResult.error) {
      return { status: "failure", errors: [sourceResult.error], message: `已完成入庫明細載入失敗：${safeSupabaseReadErrorMessage(sourceResult.error)}` };
    }
    const sourceRows = (sourceResult.data ?? []) as Array<{
      line_id: string;
      receipt_id: string;
      receipt_no: string;
      purchase_order_id: string;
      received_on: string;
      item_code: string;
      item_name: string;
      delivered_quantity: number;
      accepted_quantity: number;
      rejected_quantity: number;
    }>;
    return {
      status: "success",
      data: sourceRows.map((row) => ({
        id: row.line_id,
        receipt_id: row.receipt_id,
        receipt_no: row.receipt_no,
        purchase_order_id: row.purchase_order_id,
        received_on: row.received_on,
        item_code_snapshot: row.item_code,
        item_name_snapshot: row.item_name,
        delivered_quantity: row.delivered_quantity,
        accepted_quantity: row.accepted_quantity,
        rejected_quantity: row.rejected_quantity,
      })),
      message: `已載入 ${sourceRows.length} 筆可更正的入庫明細。`,
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
    emptyData: EMPTY_RECEIPT_LINES,
    resourceLabel: "已完成入庫明細",
    initialMessage: client ? "正在確認身份並載入可更正的入庫明細…" : "設定 Supabase 並登入後，才能讀取可更正的入庫明細。",
    read: readReceiptLines,
  });
  const selectedLine = useMemo(() => lines.find((line) => line.id === lineId), [lines, lineId]);
  const selectedReceipt = useMemo<Receipt | undefined>(() => selectedLine ? ({
    id: selectedLine.receipt_id,
    receipt_no: selectedLine.receipt_no,
    purchase_order_id: selectedLine.purchase_order_id,
    received_on: selectedLine.received_on,
  }) : undefined, [selectedLine]);
  const validationError = validateReceiptCorrectionInput({
    deliveredQuantityDelta: deliveredDelta,
    acceptedQuantityDelta: acceptedDelta,
    rejectedQuantityDelta: rejectedDelta,
    rejectionReason,
    reason,
  });
  const historyRows: CorrectionHistoryRow[] = useMemo(() => history.map((item) => ({
    id: item.id,
    correctionNo: item.correction_no,
    status: item.status,
    reason: item.reason,
    deltaText: `${item.delivered_quantity_delta}／${item.accepted_quantity_delta}／${item.rejected_quantity_delta}`,
    postedAt: item.posted_at,
  })), [history]);

  useEffect(() => {
    if (!sourceSnapshotReady) return;
    const recoveredLineId = recoveredLineIdRef.current;
    setLineId((current) => {
      if (recoveredLineId && lines.some((line) => line.id === recoveredLineId)) return recoveredLineId;
      return lines.some((line) => line.id === current) ? current : "";
    });
  }, [lines, sourceSnapshotReady]);

  useEffect(() => {
    if (!identityReady || !client) return;
    const supabase = client;
    const savedCreateKey = window.localStorage.getItem(`${STORAGE_PREFIX}:create-key`);
    const savedPostKey = window.localStorage.getItem(`${STORAGE_PREFIX}:post-key`);
    const savedCorrectionId = window.localStorage.getItem(`${STORAGE_PREFIX}:id`);
    if (savedCreateKey) createKeyRef.current = savedCreateKey;
    if (savedPostKey) postKeyRef.current = savedPostKey;
    let active = true;
    async function recover() {
      if (!savedCorrectionId && !savedCreateKey && !savedPostKey) { setCompletionUnresolved(false); return; }
      const [statusResult] = await retrySupabaseQueriesAfterSessionRefresh(
        supabase,
        async () => [await supabase.rpc("get_purchase_receipt_correction_status", {
          p_correction_note_id: savedCorrectionId,
          p_create_idempotency_key: savedCreateKey ? `RECEIPT-CORRECTION-DRAFT-${savedCreateKey}` : null,
          p_post_idempotency_key: savedPostKey ? `POST-RECEIPT-CORRECTION-${savedPostKey}` : null,
        })] as const,
      );
      if (!active) return;
      if (statusResult.error) { setMessage(`更正操作結果尚未確認：${safeSupabaseReadErrorMessage(statusResult.error)}`); setCompletionUnresolved(true); return; }
      if (statusResult.data?.id) setCompletionUnresolved(false);
      if (statusResult.data?.id) {
        const recovered = statusResult.data as Correction;
        setCorrection(recovered);
        window.localStorage.setItem(`${STORAGE_PREFIX}:id`, recovered.id);
        const [lineResult] = await retrySupabaseQueriesAfterSessionRefresh(
          supabase,
          async () => [await supabase.from("purchase_receipt_correction_lines")
            .select("original_receipt_line_id").eq("correction_note_id", recovered.id).maybeSingle()] as const,
        );
        if (lineResult.data?.original_receipt_line_id) {
          recoveredLineIdRef.current = lineResult.data.original_receipt_line_id as string;
          if (active) setLineId(lineResult.data.original_receipt_line_id as string);
        }
        setMessage("已恢復上一筆更正操作；請確認狀態後繼續。");
      } else {
        createKeyRef.current = null; postKeyRef.current = null;
        window.localStorage.removeItem(`${STORAGE_PREFIX}:create-key`);
        window.localStorage.removeItem(`${STORAGE_PREFIX}:post-key`);
        window.localStorage.removeItem(`${STORAGE_PREFIX}:post-fingerprint`);
        window.localStorage.removeItem(`${STORAGE_PREFIX}:id`);
        setCompletionUnresolved(false);
        setMessage("查無尚未完成的入庫更正；已解除暫鎖，請重新選擇來源並填寫資料。");
      }
    }
    void recover();
    return () => { active = false; };
  }, [client, identityReady, setMessage]);

  useEffect(() => {
    if (!identityReady || !client || !selectedReceipt || !selectedLine) return;
    const supabase = client;
    const receipt = selectedReceipt;
    const receiptLineId = selectedLine.id;
    let active = true;
    async function loadHistory() {
      const result = await loadCorrectionHistory(supabase, { kind: "PURCHASE_RECEIPT", parentId: receipt.id, lineId: receiptLineId });
      if (!active) return;
      if (result.error) { setMessage("入庫更正歷史載入失敗，請重新整理後再試。"); return; }
      setHistory(result.data.map((row) => ({
        id: row.id,
        correction_no: row.correction_no,
        status: row.status,
        reason: row.reason,
        delivered_quantity_delta: row.delivered_quantity_delta,
        accepted_quantity_delta: row.accepted_quantity_delta,
        rejected_quantity_delta: row.rejected_quantity_delta,
        posted_at: row.posted_at,
      })));
    }
    void loadHistory();
    return () => { active = false; };
  }, [client, identityReady, selectedReceipt, selectedLine, setMessage]);

  function resetOperationKeys() {
    setCompletionUnresolved(false);
    createKeyRef.current = null; postKeyRef.current = null;
    window.localStorage.removeItem(`${STORAGE_PREFIX}:create-key`);
    window.localStorage.removeItem(`${STORAGE_PREFIX}:post-key`);
    window.localStorage.removeItem(`${STORAGE_PREFIX}:post-fingerprint`);
  }
  function chooseLine(nextId: string) {
    recoveredLineIdRef.current = null;
    resetOperationKeys(); window.localStorage.removeItem(`${STORAGE_PREFIX}:id`);
    setLineId(nextId); setCorrection(null); setCorrectionNo(""); setReason("");
    setDeliveredDelta(0); setAcceptedDelta(0); setRejectedDelta(0); setRejectionReason("");
  }
  function changeNumber(setter: (value: number) => void, value: string) {
    resetOperationKeys(); setter(Number(value) || 0);
  }

  async function createDraft(keepBusy = false): Promise<Correction | null> {
    if (!client || !selectedLine || !selectedReceipt) { setMessage("請先選擇已完成的入庫單明細。"); return null; }
    if (validationError || !correctionNo.trim()) { setMessage(validationError ?? "請填寫更正單號。"); return null; }
    setBusy(true); setMessage("");
    const key = createKeyRef.current ?? crypto.randomUUID(); createKeyRef.current = key;
    window.localStorage.setItem(`${STORAGE_PREFIX}:create-key`, key);
    const payload = { lineId: selectedLine.id, correctionNo: correctionNo.trim(), deliveredDelta, acceptedDelta, rejectedDelta, rejectionReason: rejectionReason.trim(), reason: reason.trim() };
    const { data, error } = await client.rpc("create_purchase_receipt_correction_draft", {
      p_correction_no: correctionNo.trim(), p_original_receipt_line_id: selectedLine.id,
      p_delivered_quantity_delta: deliveredDelta, p_accepted_quantity_delta: acceptedDelta,
      p_rejected_quantity_delta: rejectedDelta, p_rejection_reason: rejectionReason.trim() || null,
      p_reason: reason.trim(), p_idempotency_key: `RECEIPT-CORRECTION-DRAFT-${key}`, p_request_fingerprint: JSON.stringify(payload),
    });
    if (error || !data?.id) {
      setMessage(safeSupabaseMutationErrorMessage(error, "更正草稿結果尚未確認；請使用相同操作重試。"));
      if (!keepBusy) setBusy(false);
      return null;
    }
    const created = data as Correction;
    setCorrection(created); createKeyRef.current = null;
    window.localStorage.removeItem(`${STORAGE_PREFIX}:create-key`);
    window.localStorage.setItem(`${STORAGE_PREFIX}:id`, created.id);
    setMessage("更正草稿已建立；確認後送出。");
    if (!keepBusy) setBusy(false);
    return created;
  }

  async function postDraft(correctionToPost: Correction | null = correction): Promise<boolean> {
    if (!client || !correctionToPost || correctionToPost.status !== "DRAFT") return false;
    setBusy(true); setMessage("");
    const key = postKeyRef.current ?? crypto.randomUUID(); postKeyRef.current = key;
    window.localStorage.setItem(`${STORAGE_PREFIX}:post-key`, key);
    const idempotencyKey = `POST-RECEIPT-CORRECTION-${key}`;
    const requestFingerprint = window.localStorage.getItem(`${STORAGE_PREFIX}:post-fingerprint`)
      ?? JSON.stringify({ correctionId: correctionToPost.id, correctionNo: correctionToPost.correction_no });
    const { data, error } = await client.rpc("post_purchase_receipt_correction", {
      p_correction_note_id: correctionToPost.id, p_idempotency_key: idempotencyKey,
      p_request_fingerprint: requestFingerprint,
    });
    if (error || !data?.id) {
      setMessage(safeSupabaseMutationErrorMessage(error, "更正結果尚未確認；請使用相同操作重試。"));
      setBusy(false);
      return false;
    }
    const posted = data as Correction;
    setCorrection(posted); postKeyRef.current = null;
    window.localStorage.removeItem(`${STORAGE_PREFIX}:post-key`); window.localStorage.removeItem(`${STORAGE_PREFIX}:post-fingerprint`);
    window.localStorage.setItem(`${STORAGE_PREFIX}:id`, posted.id);
    notifyInventoryDataChanged();
    setMessage("入庫更正已完成；有效合格量、總倉餘額與採購單進度已在同一交易重算。");
    setCompletionUnresolved(false);
    setBusy(false);
    return true;
  }

  async function completeCorrection() {
    if (correction) {
      await postDraft(correction);
      return;
    }
    if (!client || !selectedLine || !correctionNo.trim() || validationError) return;
    setBusy(true); setMessage("");
    const createKey = createKeyRef.current ?? crypto.randomUUID();
    const postKey = postKeyRef.current ?? crypto.randomUUID();
    createKeyRef.current = createKey; postKeyRef.current = postKey;
    window.localStorage.setItem(`${STORAGE_PREFIX}:create-key`, createKey);
    window.localStorage.setItem(`${STORAGE_PREFIX}:post-key`, postKey);
    const payload = { lineId: selectedLine.id, correctionNo: correctionNo.trim(), deliveredDelta, acceptedDelta, rejectedDelta, rejectionReason: rejectionReason.trim(), reason: reason.trim() };
    const createIdempotencyKey = `RECEIPT-CORRECTION-DRAFT-${createKey}`;
    const createRequestFingerprint = JSON.stringify(payload);
    const postIdempotencyKey = `POST-RECEIPT-CORRECTION-${postKey}`;
    const postRequestFingerprint = correctionPostRequestFingerprint("POST_PURCHASE_RECEIPT_CORRECTION", postIdempotencyKey);
    window.localStorage.setItem(`${STORAGE_PREFIX}:post-fingerprint`, postRequestFingerprint);
    const createArgs = {
      p_correction_no: correctionNo.trim(), p_original_receipt_line_id: selectedLine.id,
      p_delivered_quantity_delta: deliveredDelta, p_accepted_quantity_delta: acceptedDelta,
      p_rejected_quantity_delta: rejectedDelta, p_rejection_reason: rejectionReason.trim() || null,
      p_reason: reason.trim(), p_idempotency_key: createIdempotencyKey,
      p_request_fingerprint: createRequestFingerprint,
    };
    const completionPlan = correctionCompletionPlan({
      atomicFunctionName: "complete_purchase_receipt_correction",
      createFunctionName: "create_purchase_receipt_correction_draft",
      createArgs,
      postFunctionName: "post_purchase_receipt_correction",
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
      setMessage("入庫更正已完成；有效合格量、總倉餘額與採購單進度已在同一交易重算。");
    } else if (result.correction?.status === "DRAFT") {
      setCorrection(result.correction as Correction); createKeyRef.current = null;
      window.localStorage.removeItem(`${STORAGE_PREFIX}:create-key`); window.localStorage.setItem(`${STORAGE_PREFIX}:id`, result.correction.id);
      setCompletionUnresolved(false);
      setMessage(result.error
        ? safeSupabaseMutationErrorMessage(result.error, "入庫更正草稿已建立，完成結果尚未確認；請重試同一筆。")
        : "入庫更正草稿已建立，完成結果尚未確認；請重試同一筆。");
    } else if (result.outcomeUnknown) {
      setCompletionUnresolved(true);
      setMessage("入庫更正結果尚未確認；欄位已暫時鎖定，請按「重試同一筆」查回。");
    } else {
      createKeyRef.current = null; postKeyRef.current = null;
      window.localStorage.removeItem(`${STORAGE_PREFIX}:create-key`); window.localStorage.removeItem(`${STORAGE_PREFIX}:post-key`); window.localStorage.removeItem(`${STORAGE_PREFIX}:post-fingerprint`);
      setCompletionUnresolved(false);
      setMessage(safeSupabaseMutationErrorMessage(result.error, "入庫更正建立或完成失敗；請檢查資料後重試。"));
    }
    setBusy(false);
  }

  function startAnother() {
    recoveredLineIdRef.current = null;
    resetOperationKeys();
    window.localStorage.removeItem(`${STORAGE_PREFIX}:id`);
    setLineId(""); setCorrection(null); setCorrectionNo(""); setReason("");
    setDeliveredDelta(0); setAcceptedDelta(0); setRejectedDelta(0); setRejectionReason("");
    setMessage("可建立下一筆入庫更正。");
  }

  if (!client) return <section className="panel import-panel" aria-label="採購入庫更正"><div className="panel-heading"><div><p className="eyebrow">14 / RECEIPT CORRECTION</p><h2>採購入庫更正</h2></div><span className="status-pill">預覽模式</span></div><p className="auth-message">登入 WAREHOUSE 帳號後，可選擇已完成的入庫明細建立具理由的更正單。</p></section>;
  const sourceReadBlocked = dataLoading && !sourceSnapshotReady;
  return <section className="panel import-panel" aria-label="採購入庫更正" aria-busy={busy || dataLoading}>
    <div className="panel-heading"><div><p className="eyebrow">14 / RECEIPT CORRECTION</p><h2>採購入庫更正</h2></div><span className={`status-pill ${workflowStatusTone(correction?.status)}`}>{completionUnresolved ? "結果待確認" : workflowStatusLabel(correction?.status)}</span></div>
    <p className="auth-message">更正只可指向已完成的原始入庫明細；送出時系統會鎖定品號、採購單與原入庫，再重算有效到貨／合格／拒收及總倉差額。更正完成後不可修改。</p>
    <div className="form-grid">
      <label className="field"><span>原始入庫明細</span><select value={lineId} onChange={(event) => chooseLine(event.target.value)} disabled={busy || completionUnresolved || sourceReadBlocked || Boolean(correction)}><option value="">{sourceReadBlocked ? "載入入庫明細中…" : "請選擇"}</option>{lines.map((line) => <option key={line.id} value={line.id}>{line.receipt_no}｜{line.item_code_snapshot}｜原到貨 {line.delivered_quantity}／合格 {line.accepted_quantity}／拒收 {line.rejected_quantity}</option>)}</select></label>
      <div className="metric"><span>原始品號</span><strong>{selectedLine?.item_code_snapshot ?? "—"}</strong><small>{selectedLine?.item_name_snapshot ?? selectedReceipt?.receipt_no ?? "請先選擇明細"}</small></div>
      <label className="field"><span>更正單號</span><input value={correctionNo} onChange={(event) => { resetOperationKeys(); setCorrectionNo(event.target.value); }} maxLength={80} disabled={busy || completionUnresolved || Boolean(correction)} placeholder="例如 RTC-2026-001" /></label>
      <label className="field"><span>到貨量差額</span><input type="number" step={1} value={deliveredDelta} onChange={(event) => changeNumber(setDeliveredDelta, event.target.value)} disabled={busy || completionUnresolved || Boolean(correction)} /></label>
      <label className="field"><span>合格量差額</span><input type="number" step={1} value={acceptedDelta} onChange={(event) => changeNumber(setAcceptedDelta, event.target.value)} disabled={busy || completionUnresolved || Boolean(correction)} /></label>
      <label className="field"><span>拒收量差額</span><input type="number" step={1} value={rejectedDelta} onChange={(event) => changeNumber(setRejectedDelta, event.target.value)} disabled={busy || completionUnresolved || Boolean(correction)} /></label>
    </div>
    {selectedLine ? (() => {
      const posted = history.filter((item) => item.status === "POSTED");
      const effective = posted.reduce((totals, item) => ({
        delivered: totals.delivered + item.delivered_quantity_delta,
        accepted: totals.accepted + item.accepted_quantity_delta,
        rejected: totals.rejected + item.rejected_quantity_delta,
      }), { delivered: selectedLine.delivered_quantity, accepted: selectedLine.accepted_quantity, rejected: selectedLine.rejected_quantity });
      return <div className="metric"><span>目前有效數量（原始＋已完成更正）</span><strong>到貨 {effective.delivered}／合格 {effective.accepted}／拒收 {effective.rejected}</strong><small>{posted.length > 0 ? `已有 ${posted.length} 筆完成更正` : "尚無完成更正"}</small></div>;
    })() : null}
    <CorrectionHistoryTable ariaLabel="採購入庫更正歷史" rows={historyRows} deltaLabel="差額（到貨／合格／拒收）" />
    <label className="field reason-field"><span>更正原因</span><input value={reason} onChange={(event) => { resetOperationKeys(); setReason(event.target.value); }} maxLength={500} disabled={busy || completionUnresolved || Boolean(correction)} placeholder="例如：供應商補送後更正原收貨紀錄" /></label>
    <label className="field reason-field"><span>拒收理由（拒收差額增加時必填）</span><input value={rejectionReason} onChange={(event) => { resetOperationKeys(); setRejectionReason(event.target.value); }} maxLength={500} disabled={busy || completionUnresolved || Boolean(correction)} placeholder="例如：補驗後判定瑕疵" /></label>
    {dataLoading ? <p className="sr-only" role="status" aria-live="polite">正在讀取可更正的入庫明細…</p> : null}
    {validationError ? <p className="auth-message">{validationError}</p> : null}
    <WorkflowActionBar
      primary={{
        onClick: () => void completeCorrection(),
        busy,
        busyLabel: "處理中…",
        disabled: busy || sourceReadBlocked || !selectedLine || !correctionNo.trim() || Boolean(validationError) || correction?.status === "POSTED",
        label: correction?.status === "POSTED" ? "已完成" : completionUnresolved ? "重試同一筆（結果待確認）" : "確認並完成入庫更正",
      }}
      secondary={!correction
        ? <button className="secondary-button" type="button" onClick={() => void createDraft()} disabled={busy || completionUnresolved || sourceReadBlocked || !selectedLine}>{busy ? "建立中…" : sourceReadBlocked ? "載入來源中…" : "先建立入庫更正草稿"}</button>
        : <button className="secondary-button" type="button" onClick={startAnother} disabled={busy}>建立另一筆更正</button>}
    />
    {correction ? <p className="success-note">更正單 {correction.correction_no}／{workflowStatusLabel(correction.status)}。{correction.status === "DRAFT" ? "確認數量差額與理由後即可送出。" : "更正已鎖定，不能再次修改。"}</p> : null}
    {message ? <p className={message.includes("已") ? "success-note" : "auth-message"} role="status">{message}</p> : null}
  </section>;
}
