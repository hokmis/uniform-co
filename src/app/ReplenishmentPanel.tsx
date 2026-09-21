"use client";

import { useEffect, useRef, useState } from "react";
import { hrRequestWorkflowChangedEvent } from "@/src/domain/hr-request-events";
import { canCancelReplenishmentEntry, canEditReplenishmentEntry, markReplenishmentCancellationUnknown, resolveReplenishmentCancellationFailure, resolveReplenishmentEntryState, type ReplenishmentEntryState } from "@/src/domain/replenishment-entry-state";
import { submitReplenishmentOperation } from "@/src/domain/replenishment-submission";
import { shouldPreserveReadSnapshot, staleReadSnapshotMessage } from "@/src/domain/read-refresh";
import { loadActiveItemOptions } from "@/src/lib/master-data-cache";
import { safeSupabaseMutationErrorMessage } from "@/src/lib/supabase-session";
import { usePanelActivity } from "./RetainedPanelSet";
import { useWorkspaceSession } from "./workspace-session";

type ItemOption = { id: string; item_code: string; item_name: string; unit: string; size: string | null };
type RequestLine = { itemId: string; quantity: number };

const previewItems: ItemOption[] = [
  { id: "item-m", item_code: "U-M", item_name: "測試上衣", unit: "件", size: "M" },
  { id: "item-l", item_code: "U-L", item_name: "測試長褲", unit: "件", size: "L" },
];

function requestNo() {
  return `REP-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
}

export default function ReplenishmentPanel() {
  const { client, accountId, identityError, identityLoading, isAuthenticated } = useWorkspaceSession();
  const panelActive = usePanelActivity();
  const previewMode = !client;
  const identityReady = Boolean(client && panelActive && isAuthenticated && accountId && !identityLoading && !identityError);
  const [items, setItems] = useState<ItemOption[]>(previewMode ? previewItems : []);
  const [lines, setLines] = useState<RequestLine[]>(previewMode ? [{ itemId: previewItems[0].id, quantity: 1 }] : [{ itemId: "", quantity: 1 }]);
  const [note, setNote] = useState("");
  const [dataReady, setDataReady] = useState(!client);
  const [dataLoading, setDataLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [entryState, setEntryState] = useState<ReplenishmentEntryState>({ kind: "new" });
  const submitted = entryState.kind === "submitted";
  const submissionUnresolved = entryState.kind === "submission-unknown";
  const cancellationUnresolved = entryState.kind === "cancellation-unknown";
  const canCancelRequest = canCancelReplenishmentEntry(entryState);
  const [cancelReason, setCancelReason] = useState("");
  const operationRef = useRef<{ createKey: string; updateKey: string; submitKey: string; cancelKey?: string } | null>(null);
  const itemsRef = useRef<ItemOption[]>(items);
  const [itemsSnapshotAccountId, setItemsSnapshotAccountId] = useState<string | null>(previewMode ? accountId : null);
  const itemsSnapshotAccountIdRef = useRef<string | null>(previewMode ? accountId : null);

  const hasCurrentItemSnapshot = previewMode || Boolean(
    identityReady
      && dataReady
      && itemsSnapshotAccountId
      && itemsSnapshotAccountId === accountId,
  );
  const itemsReadBlocked = !hasCurrentItemSnapshot;
  const visibleItems = hasCurrentItemSnapshot ? items : [];
  const visibleLines = hasCurrentItemSnapshot ? lines : [{ itemId: "", quantity: 1 }];

  function markDraftChanged() {
    if (operationRef.current) {
      operationRef.current = {
        ...operationRef.current,
        createKey: entryState.kind === "draft" ? operationRef.current.createKey : crypto.randomUUID(),
        updateKey: crypto.randomUUID(),
        submitKey: crypto.randomUUID(),
      };
    }
  }

  useEffect(() => {
    if (!identityReady || !client) return;
    const supabase = client;
    let active = true;
    async function loadItems() {
      setDataLoading(true);
      try {
        const { items, errors } = await loadActiveItemOptions(supabase);
        if (!active) return;
        if (errors.length > 0 || items.length === 0) {
          const preserveSnapshot = shouldPreserveReadSnapshot(itemsRef.current, errors);
          if (!preserveSnapshot) {
            itemsRef.current = [];
            setItems([]);
            itemsSnapshotAccountIdRef.current = null;
            setItemsSnapshotAccountId(null);
            setLines([{ itemId: "", quantity: 1 }]);
            setDataReady(false);
          }
          setMessage(preserveSnapshot
            ? staleReadSnapshotMessage("補庫品號")
            : "正式制服品號載入失敗或沒有可用品號，請確認 HR 角色與資料權限。");
          return;
        }
        const loaded = items as ItemOption[];
        const sameAccountSnapshot = itemsSnapshotAccountIdRef.current === accountId;
        itemsRef.current = loaded;
        setItems(loaded);
        itemsSnapshotAccountIdRef.current = accountId;
        setItemsSnapshotAccountId(accountId);
        setLines((current) => sameAccountSnapshot && current.length > 0 ? current : [{ itemId: "", quantity: 1 }]);
        setDataReady(true);
      } finally {
        if (active) setDataLoading(false);
      }
    }
    void loadItems();
    return () => { active = false; };
  }, [accountId, client, identityReady, panelActive]);

  function updateLine(index: number, field: keyof RequestLine, value: string) {
    markDraftChanged();
    setLines((current) => current.map((line, lineIndex) => lineIndex === index
      ? { ...line, [field]: field === "quantity" ? Math.max(0, Number(value) || 0) : value }
      : line));
  }

  function addLine() {
    if (itemsReadBlocked || lines.length >= visibleItems.length) return;
    markDraftChanged();
    setLines((current) => [...current, { itemId: "", quantity: 1 }]);
  }

  function changeCancelReason(nextReason: string) {
    if (operationRef.current?.cancelKey && nextReason !== cancelReason) {
      operationRef.current = { ...operationRef.current, cancelKey: undefined };
    }
    setCancelReason(nextReason);
  }

  function removeLine(index: number) {
    markDraftChanged();
    setLines((current) => current.length === 1 ? current : current.filter((_, lineIndex) => lineIndex !== index));
  }

  async function submit() {
    if (!identityReady || !client) {
      setMessage("預覽模式：設定 Supabase env 並登入 HR 帳號後才能建立補庫單。");
      return;
    }
    if (itemsReadBlocked || entryState.kind === "submitted" || lines.some((line) => !line.itemId || line.quantity < 1)) {
      setMessage("請選擇每個補庫品號，並確認數量為正整數。");
      return;
    }
    if (new Set(lines.map((line) => line.itemId)).size !== lines.length) {
      setMessage("同一補庫單不可重複相同品號。");
      return;
    }
    setBusy(true);
    setMessage("");
    const operation = operationRef.current ?? { createKey: crypto.randomUUID(), updateKey: crypto.randomUUID(), submitKey: crypto.randomUUID() };
    operationRef.current = operation;
    const requestId = entryState.kind === "draft" || entryState.kind === "submission-unknown"
      ? entryState.requestId
      : null;
    const payload = lines.map((line) => ({ itemId: line.itemId, quantity: line.quantity }));
    const trimmedNote = note.trim();
    const result = await submitReplenishmentOperation(
      (functionName, args) => client.rpc(functionName, args),
      {
        requestId,
        requestNo: requestNo(),
        note: trimmedNote,
        lines: payload,
        createIdempotencyKey: `CREATE-REPLENISHMENT-${operation.createKey}`,
        createRequestFingerprint: JSON.stringify({ payload, note: trimmedNote }),
        updateIdempotencyKey: `UPDATE-REPLENISHMENT-${operation.updateKey}`,
        updateRequestFingerprint: JSON.stringify({ requestId, payload, note: trimmedNote }),
        submitIdempotencyKey: `SUBMIT-REPLENISHMENT-${operation.submitKey}`,
      },
      client,
    );
    const nextEntryState = resolveReplenishmentEntryState(entryState, result);
    setEntryState(nextEntryState);
    if (result.failureStage || nextEntryState.kind !== "submitted") {
      setMessage(result.outcomeUnknown
        ? "送出結果尚未確認；請重試同一筆，不要修改內容或另建補庫單。"
        : safeSupabaseMutationErrorMessage(result.error, "補庫單送出失敗；確認資料後可重新送出。"));
      setBusy(false);
      return;
    }
    setMessage(`補庫單 ${nextEntryState.requestNo} 已送出，倉庫可依現有總倉庫存完成調庫。`);
    window.dispatchEvent(new Event(hrRequestWorkflowChangedEvent));
    setBusy(false);
  }

  async function cancelRequest() {
    const operation = operationRef.current;
    if (
      !identityReady || !client || !operation
      || (entryState.kind !== "draft" && entryState.kind !== "cancellation-unknown")
    ) return;
    const draftId = entryState.requestId;
    const reason = entryState.kind === "cancellation-unknown" ? entryState.reason : cancelReason.trim();
    if (!reason) {
      setMessage("取消前請填寫原因。");
      return;
    }
    setBusy(true);
    setMessage("");
    const cancelKey = operation.cancelKey ?? crypto.randomUUID();
    operationRef.current = { ...operation, cancelKey };
    try {
      const { data, error } = await client.rpc("cancel_replenishment_request", {
        p_request_id: draftId,
        p_reason: reason,
        p_idempotency_key: `CANCEL-REPLENISHMENT-${cancelKey}`,
        p_request_fingerprint: JSON.stringify({ requestId: draftId, reason }),
      });
      if (error) {
        setEntryState(resolveReplenishmentCancellationFailure(entryState));
        setMessage(safeSupabaseMutationErrorMessage(error, "補庫單取消失敗；請檢查資料後再試。"));
      } else if (!data?.id) {
        setEntryState(markReplenishmentCancellationUnknown(entryState, reason));
        setMessage("取消結果尚未確認；請使用相同原因重試，不要修改補庫單內容。");
      } else {
        operationRef.current = null;
        setEntryState({ kind: "new" });
        setCancelReason("");
        setNote("");
        setLines([{ itemId: "", quantity: 1 }]);
        setMessage(`補庫單 ${data.request_no ?? ""} 已取消。`);
        window.dispatchEvent(new Event(hrRequestWorkflowChangedEvent));
      }
    } catch {
      setEntryState(markReplenishmentCancellationUnknown(entryState, reason));
      setMessage("取消結果尚未確認；請使用相同原因重試，不要修改補庫單內容。");
    } finally {
      setBusy(false);
    }
  }

  function startNextRequest() {
    operationRef.current = null;
    setEntryState({ kind: "new" });
    setCancelReason("");
    setNote("");
    setLines([{ itemId: "", quantity: 1 }]);
    setMessage("可建立下一筆補庫單。");
  }

  if (!client) {
    return <section className="panel import-panel" aria-label="額外補庫申請"><div className="panel-heading"><div><p className="eyebrow">06 / REPLENISHMENT</p><h2>額外補庫申請</h2></div><span className="status-pill">預覽模式</span></div><p className="auth-message">設定 Supabase env 並登入 HR 帳號後，可建立不預留庫存的補庫單；倉庫確認完成時才依總倉現有庫存調庫。</p></section>;
  }

  return (
    <section className="panel import-panel" aria-label="額外補庫申請" aria-busy={dataLoading || busy}>
      <div className="panel-heading"><div><p className="eyebrow">06 / REPLENISHMENT</p><h2>額外補庫申請</h2></div><span className={`status-pill ${submitted ? "success" : ""}`}>{submitted ? "已送出" : submissionUnresolved ? "送出結果待確認" : cancellationUnresolved ? "取消結果待確認" : itemsReadBlocked && dataLoading ? "載入中…" : dataLoading ? "同步中…" : "草稿"}</span></div>
      <p className="auth-message">補庫單不預留庫存；倉庫收到後以總倉當下可用量確認完成，短發項目另填原因。</p>
      {dataLoading ? <p className="sr-only" role="status" aria-live="polite">正在載入可用制服品號…</p> : null}
      <label className="field"><span>備註（選填）</span><input value={note} onChange={(event) => { markDraftChanged(); setNote(event.target.value); }} disabled={busy || !canEditReplenishmentEntry(entryState)} maxLength={2000} placeholder="例如：換季前補足人資倉常用尺寸" /></label>
      <div className="summary-list">
        {visibleLines.map((line, index) => {
          const item = visibleItems.find((option) => option.id === line.itemId);
          return <div className="summary-row" key={`${line.itemId}-${index}`}>
            <label className="field"><span>制服品號</span><select value={line.itemId} onChange={(event) => updateLine(index, "itemId", event.target.value)} disabled={busy || !canEditReplenishmentEntry(entryState) || itemsReadBlocked}><option value="">{itemsReadBlocked && dataLoading ? "載入品號中…" : "請選擇制服品號"}</option>{visibleItems.map((option) => <option key={option.id} value={option.id}>{option.item_code}｜{option.item_name}{option.size ? `｜${option.size}` : ""}</option>)}</select><small>{item?.unit ?? ""}</small></label>
            <label className="field"><span>申請數量</span><input type="number" min={1} max={999999999} value={line.quantity} onChange={(event) => updateLine(index, "quantity", event.target.value)} disabled={busy || !canEditReplenishmentEntry(entryState) || itemsReadBlocked} /></label>
            <button className="text-button" type="button" onClick={() => removeLine(index)} disabled={busy || !canEditReplenishmentEntry(entryState) || itemsReadBlocked || visibleLines.length === 1}>移除</button>
          </div>;
        })}
      </div>
      <div className="button-row"><button className="secondary-button" type="button" onClick={addLine} disabled={busy || itemsReadBlocked || !canEditReplenishmentEntry(entryState) || lines.length >= visibleItems.length}>{itemsReadBlocked && dataLoading ? "載入品號中…" : "新增品號"}</button><button className="primary-button" type="button" onClick={() => void submit()} disabled={busy || submitted || cancellationUnresolved || (!submissionUnresolved && itemsReadBlocked) || !identityReady}>{busy ? "送出中…" : submitted ? "已送出" : submissionUnresolved ? "重試同一筆送出" : cancellationUnresolved ? "取消結果待確認" : itemsReadBlocked && dataLoading ? "載入品號中…" : entryState.kind === "draft" ? "保存修改並送出" : "建立並送出補庫單"}</button>{submitted ? <button className="secondary-button" type="button" onClick={startNextRequest} disabled={busy}>建立下一筆補庫單</button> : null}</div>
      {canCancelRequest ? <div className="button-row"><label className="field"><span>取消原因（必填）</span><input value={cancelReason} onChange={(event) => { if (!cancellationUnresolved) changeCancelReason(event.target.value); }} disabled={busy || cancellationUnresolved} maxLength={2000} placeholder="例如：需求取消／資料重複" /></label><button className="secondary-button" type="button" onClick={() => void cancelRequest()} disabled={busy}>{cancellationUnresolved ? "重試同一筆取消" : "取消本張補庫單"}</button></div> : null}
      {(identityError || message) ? <p className={(message.includes("已送出") || message.includes("已取消")) && !identityError ? "success-note" : "auth-message"} role="status">{identityError ?? message}</p> : null}
    </section>
  );
}
