"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CorrectionHistoryTable from "@/src/app/CorrectionHistoryTable";
import type { CorrectionHistoryRow } from "@/src/domain/correction-history";
import { completeCorrectionOperation, correctionCompletionPlan, correctionPostRequestFingerprint } from "@/src/domain/correction-completion";
import type { AccountScopedReadOutcome } from "@/src/domain/account-scoped-read";
import { retrySupabaseQueriesAfterSessionRefresh, safeSupabaseMutationErrorMessage, safeSupabaseReadErrorMessage } from "@/src/lib/supabase-session";
import { notifyInventoryDataChanged } from "@/src/domain/inventory-events";
import { validateWarehouseTransferCorrectionInput } from "@/src/domain/warehouse-transfer-correction";
import { loadCorrectionHistory } from "@/src/lib/correction-history-read";
import { useWorkspaceSession } from "./workspace-session";
import { useAccountScopedReadSnapshot } from "./use-account-scoped-read-snapshot";
import { workflowStatusLabel, workflowStatusTone } from "@/src/domain/workflow-status";
import { usePanelActivity } from "./RetainedPanelSet";
import WorkflowActionBar from "./WorkflowActionBar";

type Kind = "SHIPMENT" | "REPLENISHMENT";
type Source = { kind: Kind; lineId: string; parentId: string; parentNo: string; itemCode: string; itemName: string; actual: number; requested: number };
type Correction = { id: string; correction_no: string; status: "DRAFT" | "POSTED" };
type History = { id: string; correction_no: string; status: string; reason: string; delta: number; posted_at: string | null };
const PREFIX = "uniform:warehouse-transfer-correction";
const EMPTY_TRANSFER_SOURCES: Source[] = [];

export default function WarehouseTransferCorrectionPanel() {
  const { client, isAuthenticated, accountId, identityError, identityLoading } = useWorkspaceSession();
  const panelActive = usePanelActivity();
  const hasSession = isAuthenticated;
  const identityReady = Boolean(client && panelActive && hasSession && accountId && !identityLoading && !identityError);
  const [sourceKey, setSourceKey] = useState("");
  const [correctionNo, setCorrectionNo] = useState("");
  const [reason, setReason] = useState("");
  const [delta, setDelta] = useState(0);
  const [correction, setCorrection] = useState<Correction | null>(null);
  const [history, setHistory] = useState<History[]>([]);
  const [busy, setBusy] = useState(false);
  const [completionUnresolved, setCompletionUnresolved] = useState(true);
  const createKeyRef = useRef<string | null>(null);
  const postKeyRef = useRef<string | null>(null);
  const recoveredSourceRef = useRef<string | null>(null);
  const readTransferSources = useCallback(async (): Promise<AccountScopedReadOutcome<Source[]>> => {
    if (!client) return { status: "failure", errors: [], message: "已完成調撥明細尚未連線。請登入後重試。" };
    const [sourceResult] = await retrySupabaseQueriesAfterSessionRefresh(
      client,
      async () => [await client.from("v_warehouse_transfer_correction_sources")
        .select("source_kind,line_id,parent_id,parent_no,item_code,item_name,actual_quantity,requested_quantity")
        .order("parent_no", { ascending: false })
        .order("line_id", { ascending: true })] as const,
    );
    if (sourceResult.error) {
      return { status: "failure", errors: [sourceResult.error], message: `已完成調撥明細載入失敗：${safeSupabaseReadErrorMessage(sourceResult.error)}` };
    }
    const loaded = ((sourceResult.data ?? []) as Array<{
      source_kind: string;
      line_id: string;
      parent_id: string;
      parent_no: string;
      item_code: string;
      item_name: string;
      actual_quantity: number | null;
      requested_quantity: number | null;
    }>).filter((row) => row.actual_quantity != null).map((row) => ({
      kind: row.source_kind as Kind,
      lineId: row.line_id,
      parentId: row.parent_id,
      parentNo: row.parent_no,
      itemCode: row.item_code,
      itemName: row.item_name,
      actual: Number(row.actual_quantity),
      requested: Number(row.requested_quantity ?? 0),
    }));
    return { status: "success", data: loaded, message: `已載入 ${loaded.length} 筆可更正的調撥明細。` };
  }, [client]);
  const {
    data: sources,
    hasCurrentSnapshot: sourceSnapshotReady,
    loading: dataLoading,
    message,
    setMessage,
  } = useAccountScopedReadSnapshot({
    accountId: accountId ?? null,
    enabled: identityReady,
    refreshKey: 0,
    emptyData: EMPTY_TRANSFER_SOURCES,
    resourceLabel: "已完成調撥明細",
    initialMessage: client ? "正在確認身份並載入可更正的調撥明細…" : "設定 Supabase 並登入後，才能讀取可更正的調撥明細。",
    read: readTransferSources,
  });
  const selected = useMemo(() => sources.find((source) => `${source.kind}:${source.lineId}` === sourceKey), [sources, sourceKey]);
  const validationError = validateWarehouseTransferCorrectionInput({ transferQuantityDelta: delta, reason });
  const historyRows: CorrectionHistoryRow[] = useMemo(() => history.map((item) => ({
    id: item.id,
    correctionNo: item.correction_no,
    status: item.status,
    reason: item.reason,
    deltaText: String(item.delta),
    postedAt: item.posted_at,
  })), [history]);

  useEffect(() => {
    if (!sourceSnapshotReady) return;
    const recovered = recoveredSourceRef.current;
    setSourceKey((current) => {
      if (recovered && sources.some((source) => `${source.kind}:${source.lineId}` === recovered)) return recovered;
      return sources.some((source) => `${source.kind}:${source.lineId}` === current) ? current : "";
    });
  }, [sourceSnapshotReady, sources]);

  useEffect(() => {
    if (!panelActive || !client || !hasSession || identityLoading || identityError || !accountId) return;
    const supabase = client;
    const createKey = window.localStorage.getItem(`${PREFIX}:create-key`);
    const postKey = window.localStorage.getItem(`${PREFIX}:post-key`);
    const savedId = window.localStorage.getItem(`${PREFIX}:id`);
    if (createKey) createKeyRef.current = createKey;
    if (postKey) postKeyRef.current = postKey;
    let active = true;
    async function recover() {
      if (!createKey && !postKey && !savedId) { setCompletionUnresolved(false); return; }
      const [statusResult] = await retrySupabaseQueriesAfterSessionRefresh(
        supabase,
        async () => [await supabase.rpc("get_warehouse_transfer_correction_status", {
          p_correction_note_id: savedId,
          p_create_idempotency_key: createKey ? `CREATE-WAREHOUSE-TRANSFER-CORRECTION-${createKey}` : null,
          p_post_idempotency_key: postKey ? `POST-WAREHOUSE-TRANSFER-CORRECTION-${postKey}` : null,
        })] as const,
      );
      const { data, error } = statusResult;
      if (!active) return;
      if (error) { setMessage("調撥更正結果尚未確認；欄位已暫時鎖定，請以相同操作重試。"); setCompletionUnresolved(true); return; }
      if (data?.id) {
        setCorrection(data as Correction); setCompletionUnresolved(false); window.localStorage.setItem(`${PREFIX}:id`, data.id as string);
        const [lineResult] = await retrySupabaseQueriesAfterSessionRefresh(
          supabase,
          async () => [await supabase.from("warehouse_transfer_correction_lines").select("original_shipment_line_id,original_replenishment_line_id").eq("correction_note_id", data.id).maybeSingle()] as const,
        );
        const { data: line } = lineResult;
        if (line) { recoveredSourceRef.current = line.original_shipment_line_id ? `SHIPMENT:${line.original_shipment_line_id}` : `REPLENISHMENT:${line.original_replenishment_line_id}`; if (active) setSourceKey(recoveredSourceRef.current); }
        setMessage("已恢復上一筆調撥更正；請確認狀態後繼續。");
      } else {
        createKeyRef.current = null; postKeyRef.current = null;
        window.localStorage.removeItem(`${PREFIX}:create-key`);
        window.localStorage.removeItem(`${PREFIX}:post-key`);
        window.localStorage.removeItem(`${PREFIX}:post-fingerprint`);
        window.localStorage.removeItem(`${PREFIX}:id`);
        setCompletionUnresolved(false);
        setMessage("查無尚未完成的調撥更正；已解除暫鎖，請重新選擇來源並填寫資料。");
      }
    }
    void recover();
    return () => { active = false; };
  }, [accountId, client, hasSession, identityError, identityLoading, panelActive, setMessage]);

  useEffect(() => {
    if (!panelActive || !client || !hasSession || identityLoading || identityError || !accountId || !selected) return;
    const supabase = client;
    const source = selected;
    let active = true;
    async function loadHistory() {
      const result = await loadCorrectionHistory(supabase, { kind: source.kind, parentId: source.parentId, lineId: source.lineId });
      if (!active) return;
      if (result.error) { setMessage("調撥更正歷史載入失敗，請重新整理後再試。"); return; }
      setHistory(result.data.map((row) => ({ id: row.id, correction_no: row.correction_no, status: row.status, reason: row.reason, delta: row.delta, posted_at: row.posted_at })));
    }
    void loadHistory();
    return () => { active = false; };
  }, [accountId, client, hasSession, identityError, identityLoading, panelActive, selected, setMessage]);

  function resetKeys() { setCompletionUnresolved(false); createKeyRef.current = null; postKeyRef.current = null; window.localStorage.removeItem(`${PREFIX}:create-key`); window.localStorage.removeItem(`${PREFIX}:post-key`); window.localStorage.removeItem(`${PREFIX}:post-fingerprint`); }
  async function createDraft(keepBusy = false): Promise<Correction | null> {
    const source = selected;
    if (!client || !source || validationError || !correctionNo.trim()) { setMessage(validationError ?? "請選擇已完成的調撥／補庫明細、填寫單號與原因。"); return null; }
    setBusy(true); setMessage("");
    const key = createKeyRef.current ?? crypto.randomUUID(); createKeyRef.current = key; window.localStorage.setItem(`${PREFIX}:create-key`, key);
    const { data, error } = await client.rpc("create_warehouse_transfer_correction_draft", { p_correction_no: correctionNo.trim(), p_source_kind: source.kind, p_source_line_id: source.lineId, p_transfer_quantity_delta: delta, p_reason: reason.trim(), p_note: null, p_idempotency_key: `CREATE-WAREHOUSE-TRANSFER-CORRECTION-${key}`, p_request_fingerprint: JSON.stringify({ sourceKind: source.kind, sourceLineId: source.lineId, correctionNo: correctionNo.trim(), delta, reason: reason.trim() }) });
    if (error || !data?.id) {
      setMessage(safeSupabaseMutationErrorMessage(error, "調撥更正結果尚未確認；請使用相同操作重試。"));
      if (!keepBusy) setBusy(false);
      return null;
    }
    const created = data as Correction;
    setCorrection(created); window.localStorage.removeItem(`${PREFIX}:create-key`); createKeyRef.current = null; window.localStorage.setItem(`${PREFIX}:id`, created.id as string); setMessage("調撥更正草稿已建立；確認後送出。");
    if (!keepBusy) setBusy(false);
    return created;
  }
  async function postDraft(correctionToPost: Correction | null = correction): Promise<boolean> {
    if (!client || !correctionToPost || correctionToPost.status !== "DRAFT") return false;
    setBusy(true); setMessage("");
    const key = postKeyRef.current ?? crypto.randomUUID(); postKeyRef.current = key; window.localStorage.setItem(`${PREFIX}:post-key`, key);
    const idempotencyKey = `POST-WAREHOUSE-TRANSFER-CORRECTION-${key}`;
    const requestFingerprint = window.localStorage.getItem(`${PREFIX}:post-fingerprint`)
      ?? JSON.stringify({ correctionId: correctionToPost.id, correctionNo: correctionToPost.correction_no });
    const { data, error } = await client.rpc("post_warehouse_transfer_correction", { p_correction_note_id: correctionToPost.id, p_idempotency_key: idempotencyKey, p_request_fingerprint: requestFingerprint });
    if (error || !data?.id) {
      setMessage(safeSupabaseMutationErrorMessage(error, "調撥更正結果尚未確認；請使用相同操作重試。"));
      setBusy(false);
      return false;
    }
    setCorrection(data as Correction); setCompletionUnresolved(false); window.localStorage.removeItem(`${PREFIX}:post-key`); window.localStorage.removeItem(`${PREFIX}:post-fingerprint`); postKeyRef.current = null; window.localStorage.setItem(`${PREFIX}:id`, correctionToPost.id); notifyInventoryDataChanged(); setMessage("調撥更正已完成；總倉／人資倉雙邊餘額與紀錄已在同一交易更新。");
    setBusy(false);
    return true;
  }
  async function completeCorrection() {
    if (correction) {
      await postDraft(correction);
      return;
    }
    if (!client || !selected || !correctionNo.trim() || validationError) return;
    setBusy(true); setMessage("");
    const createKey = createKeyRef.current ?? crypto.randomUUID();
    const postKey = postKeyRef.current ?? crypto.randomUUID();
    createKeyRef.current = createKey; postKeyRef.current = postKey;
    window.localStorage.setItem(`${PREFIX}:create-key`, createKey);
    window.localStorage.setItem(`${PREFIX}:post-key`, postKey);
    const payload = { sourceKind: selected.kind, sourceLineId: selected.lineId, correctionNo: correctionNo.trim(), delta, reason: reason.trim() };
    const createIdempotencyKey = `CREATE-WAREHOUSE-TRANSFER-CORRECTION-${createKey}`;
    const createRequestFingerprint = JSON.stringify(payload);
    const postIdempotencyKey = `POST-WAREHOUSE-TRANSFER-CORRECTION-${postKey}`;
    const postRequestFingerprint = correctionPostRequestFingerprint("POST_WAREHOUSE_TRANSFER_CORRECTION", postIdempotencyKey);
    window.localStorage.setItem(`${PREFIX}:post-fingerprint`, postRequestFingerprint);
    const createArgs = {
      p_correction_no: correctionNo.trim(), p_source_kind: selected.kind,
      p_source_line_id: selected.lineId, p_transfer_quantity_delta: delta,
      p_reason: reason.trim(), p_note: null, p_idempotency_key: createIdempotencyKey,
      p_request_fingerprint: createRequestFingerprint,
    };
    const completionPlan = correctionCompletionPlan({
      atomicFunctionName: "complete_warehouse_transfer_correction",
      createFunctionName: "create_warehouse_transfer_correction_draft",
      createArgs,
      postFunctionName: "post_warehouse_transfer_correction",
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
      window.localStorage.removeItem(`${PREFIX}:create-key`); window.localStorage.removeItem(`${PREFIX}:post-key`); window.localStorage.removeItem(`${PREFIX}:post-fingerprint`);
      window.localStorage.setItem(`${PREFIX}:id`, result.correction.id);
      setCompletionUnresolved(false); notifyInventoryDataChanged();
      setMessage("調撥更正已完成；總倉／人資倉雙邊餘額與紀錄已在同一交易更新。");
    } else if (result.correction?.status === "DRAFT") {
      setCorrection(result.correction as Correction); createKeyRef.current = null;
      window.localStorage.removeItem(`${PREFIX}:create-key`); window.localStorage.setItem(`${PREFIX}:id`, result.correction.id);
      setCompletionUnresolved(false);
      setMessage(result.error
        ? safeSupabaseMutationErrorMessage(result.error, "調撥更正草稿已建立，完成結果尚未確認；請重試同一筆。")
        : "調撥更正草稿已建立，完成結果尚未確認；請重試同一筆。");
    } else if (result.outcomeUnknown) {
      setCompletionUnresolved(true);
      setMessage("調撥更正結果尚未確認；欄位已暫時鎖定，請按「重試同一筆」查回。");
    } else {
      createKeyRef.current = null; postKeyRef.current = null;
      window.localStorage.removeItem(`${PREFIX}:create-key`); window.localStorage.removeItem(`${PREFIX}:post-key`); window.localStorage.removeItem(`${PREFIX}:post-fingerprint`);
      setCompletionUnresolved(false);
      setMessage(safeSupabaseMutationErrorMessage(result.error, "調撥更正建立或完成失敗；請檢查資料後重試。"));
    }
    setBusy(false);
  }
  function startAnother() { recoveredSourceRef.current = null; resetKeys(); window.localStorage.removeItem(`${PREFIX}:id`); setSourceKey(""); setCorrection(null); setCorrectionNo(""); setReason(""); setDelta(0); setMessage("可建立下一筆調撥更正。"); }

  if (!client) return <section className="panel import-panel" aria-label="倉庫調撥更正"><div className="panel-heading"><div><p className="eyebrow">17 / TRANSFER CORRECTION</p><h2>倉庫調撥更正</h2></div><span className="status-pill">預覽模式</span></div><p className="auth-message">登入 WAREHOUSE 帳號後，可選擇已完成的調撥／補庫明細建立更正。</p></section>;
  const effective = (selected?.actual ?? 0) + history.filter((item) => item.status === "POSTED").reduce((sum, item) => sum + item.delta, 0);
  const sourceReadBlocked = dataLoading && !sourceSnapshotReady;
  return <section className="panel import-panel" aria-label="倉庫調撥更正" aria-busy={busy || dataLoading}>
    <div className="panel-heading"><div><p className="eyebrow">17 / TRANSFER CORRECTION</p><h2>倉庫調撥更正</h2></div><span className={`status-pill ${workflowStatusTone(correction?.status)}`}>{completionUnresolved ? "結果待確認" : workflowStatusLabel(correction?.status)}</span></div>
    <p className="auth-message">更正只可指向已完成的發貨／補庫明細；正數代表總倉調入人資倉，負數代表沖回。送出時會鎖品號、來源文件與兩倉餘額，保留原始紀錄並新增更正紀錄。</p>
    <div className="form-grid">
      <label className="field"><span>原始調撥明細</span><select value={sourceKey} onChange={(event) => { recoveredSourceRef.current = null; resetKeys(); window.localStorage.removeItem(`${PREFIX}:id`); setSourceKey(event.target.value); setCorrection(null); }} disabled={busy || completionUnresolved || sourceReadBlocked || Boolean(correction)}><option value="">{sourceReadBlocked ? "載入調撥明細中…" : "請選擇"}</option>{sources.map((source) => <option key={`${source.kind}:${source.lineId}`} value={`${source.kind}:${source.lineId}`}>{source.kind === "SHIPMENT" ? "發貨" : "補庫"}｜{source.parentNo}｜{source.itemCode}｜原調撥 {source.actual}</option>)}</select></label>
      <div className="metric"><span>原始品號／有效調撥量</span><strong>{selected?.itemCode ?? "—"}／{effective}</strong><small>{selected?.itemName ?? "請先選擇明細"}；上限 {selected?.requested ?? "—"}</small></div>
      <label className="field"><span>更正單號</span><input value={correctionNo} onChange={(event) => { resetKeys(); setCorrectionNo(event.target.value); }} maxLength={80} disabled={busy || completionUnresolved || Boolean(correction)} placeholder="例如 WTC-2026-001" /></label>
      <label className="field"><span>調撥量差額</span><input type="number" step={1} value={delta} onChange={(event) => { resetKeys(); setDelta(Number(event.target.value) || 0); }} disabled={busy || completionUnresolved || Boolean(correction)} /></label>
    </div>
    <CorrectionHistoryTable ariaLabel="倉庫調撥更正歷史" rows={historyRows} deltaLabel="調撥差額" />
    <label className="field reason-field"><span>更正原因</span><input value={reason} onChange={(event) => { resetKeys(); setReason(event.target.value); }} maxLength={500} disabled={busy || completionUnresolved || Boolean(correction)} placeholder="例如：盤點後補登實際調撥" /></label>
    {dataLoading ? <p className="sr-only" role="status" aria-live="polite">正在讀取可更正的調撥／補庫明細…</p> : null}
    {validationError ? <p className="auth-message">{validationError}</p> : null}
    <WorkflowActionBar
      primary={{
        onClick: () => void completeCorrection(),
        busy,
        busyLabel: "處理中…",
        disabled: busy || sourceReadBlocked || !selected || !correctionNo.trim() || Boolean(validationError) || correction?.status === "POSTED",
        label: correction?.status === "POSTED" ? "已完成" : completionUnresolved ? "重試同一筆（結果待確認）" : "確認並完成調撥更正",
      }}
      secondary={!correction
        ? <button className="secondary-button" type="button" onClick={() => void createDraft()} disabled={busy || completionUnresolved || sourceReadBlocked || !selected}>{busy ? "建立中…" : sourceReadBlocked ? "載入來源中…" : "先建立調撥更正草稿"}</button>
        : <button className="secondary-button" type="button" onClick={startAnother} disabled={busy}>建立另一筆更正</button>}
    />
    {message ? <p className={message.includes("已") ? "success-note" : "auth-message"} role="status">{message}</p> : null}
  </section>;
}
