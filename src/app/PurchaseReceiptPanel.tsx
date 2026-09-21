"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  completePurchaseReceipt,
  type PurchaseReceiptRecord as Receipt,
  type PurchaseReceiptRpcCall,
} from "@/src/domain/purchase-receipt-completion";
import { notifyInventoryDataChanged } from "@/src/domain/inventory-events";
import { workflowStatusLabel } from "@/src/domain/workflow-status";
import { shouldPreserveReadSnapshot, staleReadSnapshotMessage } from "@/src/domain/read-refresh";
import { retrySupabaseQueriesAfterSessionRefresh, safeSupabaseMutationErrorMessage, safeSupabaseReadErrorMessage } from "@/src/lib/supabase-session";
import { usePanelActivity } from "./RetainedPanelSet";
import { useWorkspaceSession } from "./workspace-session";
import WorkflowActionBar from "./WorkflowActionBar";

type PurchaseOrder = { id: string; po_no: string; supplier_code_snapshot: string; supplier_name_snapshot: string; status: string };
type PurchaseOrderLine = { id: string; purchase_order_id: string; item_code_snapshot: string; item_name_snapshot: string; size_snapshot: string | null; unit_snapshot: string; ordered_quantity: number };

function taipeiToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
}

export default function PurchaseReceiptPanel() {
  const { client, isAuthenticated, accountId, identityError, identityLoading } = useWorkspaceSession();
  const panelActive = usePanelActivity();
  const hasSession = isAuthenticated;
  const identityReady = Boolean(client && panelActive && hasSession && accountId && !identityLoading && !identityError);
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [lines, setLines] = useState<PurchaseOrderLine[]>([]);
  const [orderId, setOrderId] = useState("");
  const [lineId, setLineId] = useState("");
  const [receiptNo, setReceiptNo] = useState("");
  const [receivedOn, setReceivedOn] = useState(taipeiToday());
  const [deliveredQuantity, setDeliveredQuantity] = useState(0);
  const [acceptedQuantity, setAcceptedQuantity] = useState(0);
  const [rejectedQuantity, setRejectedQuantity] = useState(0);
  const [rejectionReason, setRejectionReason] = useState("");
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [linesLoading, setLinesLoading] = useState(false);
  const createKeyRef = useRef<string | null>(null);
  const postKeyRef = useRef<string | null>(null);
  const postFingerprintRef = useRef<string | null>(null);
  const [dataSnapshotAccountId, setDataSnapshotAccountId] = useState<string | null>(null);
  const dataSnapshotAccountIdRef = useRef<string | null>(null);
  const ordersRef = useRef<PurchaseOrder[]>([]);
  const orderIdRef = useRef("");

  const hasCurrentDataSnapshot = Boolean(
    identityReady
      && dataSnapshotAccountId
      && dataSnapshotAccountId === accountId,
  );
  const dataReadBlocked = !hasCurrentDataSnapshot;
  const visibleOrders = useMemo(() => hasCurrentDataSnapshot ? orders : [], [hasCurrentDataSnapshot, orders]);
  const selectedOrder = useMemo(() => visibleOrders.find((order) => order.id === orderId), [orderId, visibleOrders]);
  const visibleLines = selectedOrder ? lines : [];
  const selectedLine = visibleLines.find((line) => line.id === lineId);
  const quantityBalanced = deliveredQuantity > 0 && acceptedQuantity >= 0 && rejectedQuantity >= 0 && acceptedQuantity + rejectedQuantity === deliveredQuantity;
  const dataLoading = ordersLoading || linesLoading;
  const lineSelectionLoading = linesLoading || (ordersLoading && !selectedOrder);
  const activeReceipt = hasCurrentDataSnapshot ? receipt : null;

  useEffect(() => {
    if (!identityReady || !client) return;
    const supabase = client;
    let active = true;
    async function load() {
      setOrdersLoading(true);
      try {
        const [orderResult] = await retrySupabaseQueriesAfterSessionRefresh(
          supabase,
          async () => [await supabase.from("purchase_orders")
            .select("id,po_no,supplier_code_snapshot,supplier_name_snapshot,status")
            .in("status", ["ORDERED", "PARTIALLY_RECEIVED", "REOPENED"])
            .order("po_no")] as const,
        );
        if (!active) return;
        if (orderResult.error) {
          const preserveSnapshot = dataSnapshotAccountIdRef.current === accountId
            && shouldPreserveReadSnapshot(ordersRef.current, [orderResult.error]);
          if (!preserveSnapshot) {
            ordersRef.current = [];
            setOrders([]);
            setLines([]);
            setLinesLoading(false);
            setOrderId("");
            orderIdRef.current = "";
            setLineId("");
            dataSnapshotAccountIdRef.current = null;
            setDataSnapshotAccountId(null);
          }
          setMessage(preserveSnapshot
            ? staleReadSnapshotMessage("採購單資料")
            : `採購單載入失敗：${safeSupabaseReadErrorMessage(orderResult.error)}`);
          return;
        }
        const loadedOrders = (orderResult.data ?? []) as PurchaseOrder[];
        const previousSnapshotAccountId = dataSnapshotAccountIdRef.current;
        const sameAccountSnapshot = previousSnapshotAccountId === accountId;
        if (!sameAccountSnapshot) {
          createKeyRef.current = null;
          postKeyRef.current = null;
          postFingerprintRef.current = null;
          setReceipt(null);
          setLines([]);
          setLinesLoading(false);
          setLineId("");
          setReceiptNo("");
          setDeliveredQuantity(0);
          setAcceptedQuantity(0);
          setRejectedQuantity(0);
          setRejectionReason("");
        }
        ordersRef.current = loadedOrders;
        setOrders(loadedOrders);
        dataSnapshotAccountIdRef.current = accountId;
        setDataSnapshotAccountId(accountId);
        const nextOrderId = sameAccountSnapshot && loadedOrders.some((order) => order.id === orderIdRef.current) ? orderIdRef.current : "";
        orderIdRef.current = nextOrderId;
        setOrderId(nextOrderId);
        if (!nextOrderId || loadedOrders.length === 0) { setLines([]); setLinesLoading(false); setLineId(""); }
      } finally {
        if (active) setOrdersLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, [accountId, client, identityReady, reloadToken]);

  useEffect(() => {
    if (!identityReady || !client || !orderId || !visibleOrders.some((order) => order.id === orderId) || receipt) {
      return;
    }
    const supabase = client;
    let active = true;
    async function loadLines() {
      setLinesLoading(true);
      try {
        const [lineResult] = await retrySupabaseQueriesAfterSessionRefresh(
          supabase,
          async () => [await supabase.from("purchase_order_lines")
            .select("id,purchase_order_id,item_code_snapshot,item_name_snapshot,size_snapshot,unit_snapshot,ordered_quantity")
            .eq("purchase_order_id", orderId)
            .order("line_no")] as const,
        );
        if (!active) return;
        if (lineResult.error) {
          setLines([]); setLineId("");
          setMessage(`採購單明細載入失敗：${safeSupabaseReadErrorMessage(lineResult.error)}`);
          return;
        }
        const loadedLines = (lineResult.data ?? []) as PurchaseOrderLine[];
        setLines(loadedLines);
        setLineId((current) => loadedLines.some((line) => line.id === current) ? current : "");
      } finally {
        if (active) setLinesLoading(false);
      }
    }
    void loadLines();
    return () => { active = false; };
  }, [client, identityReady, orderId, receipt, visibleOrders]);

  function resetOperationKeys() {
    createKeyRef.current = null;
    postKeyRef.current = null;
    postFingerprintRef.current = null;
  }

  function chooseLine(nextId: string) {
    resetOperationKeys();
    setLineId(nextId); setReceipt(null); setReceiptNo(""); setDeliveredQuantity(0); setAcceptedQuantity(0); setRejectedQuantity(0); setRejectionReason("");
  }

  function chooseOrder(nextId: string) {
    resetOperationKeys();
    orderIdRef.current = nextId;
    setOrderId(nextId); setLineId(""); setLines([]); setLinesLoading(false); setReceipt(null); setReceiptNo("");
    setDeliveredQuantity(0); setAcceptedQuantity(0); setRejectedQuantity(0);
    setRejectionReason(""); setMessage("");
  }

  function startNextReceipt() {
    resetOperationKeys();
    setReceipt(null);
    orderIdRef.current = "";
    setOrderId("");
    setLines([]); setLinesLoading(false);
    setLineId("");
    setReceiptNo("");
    setReceivedOn(taipeiToday());
    setDeliveredQuantity(0);
    setAcceptedQuantity(0);
    setRejectedQuantity(0);
    setRejectionReason("");
    setReloadToken((value) => value + 1);
    setMessage("本筆入庫已完成，可以選擇下一筆採購單明細。");
  }

  async function createDraft(): Promise<Receipt | null> {
    if (!identityReady || dataReadBlocked || !client || !selectedLine || !receiptNo.trim() || deliveredQuantity < 0 || acceptedQuantity < 0 || rejectedQuantity < 0) {
      setMessage("請選擇採購單明細、填寫單號與不小於 0 的暫存數量。"); return null;
    }
    setBusy(true); setMessage("");
    const key = createKeyRef.current ?? crypto.randomUUID();
    createKeyRef.current = key;
    const { data, error } = await client.rpc("create_purchase_receipt_draft", {
      p_receipt_no: receiptNo.trim(), p_purchase_order_line_id: selectedLine.id,
      p_delivered_quantity: deliveredQuantity, p_accepted_quantity: acceptedQuantity,
      p_rejected_quantity: rejectedQuantity, p_rejection_reason: rejectionReason.trim() || null,
      p_received_on: receivedOn, p_idempotency_key: `RECEIPT-DRAFT-${key}`,
      p_request_fingerprint: JSON.stringify({ lineId: selectedLine.id, receiptNo: receiptNo.trim(), deliveredQuantity, acceptedQuantity, rejectedQuantity, rejectionReason: rejectionReason.trim(), receivedOn }),
    });
    if (error) {
      setMessage(safeSupabaseMutationErrorMessage(error, "入庫草稿建立失敗；請檢查必填欄位後重試。"));
      setBusy(false);
      return null;
    }
    const createdReceipt = data as Receipt;
    setReceipt(createdReceipt);
    setMessage("已建立入庫草稿；確認實物與單據無誤後即可送出。");
    createKeyRef.current = null;
    setBusy(false);
    return createdReceipt;
  }

  async function postReceipt(receiptToPost: Receipt | null = receipt): Promise<boolean> {
    if (!identityReady || dataReadBlocked || !client || !receiptToPost) { setMessage("請先建立入庫草稿。"); return false; }
    setBusy(true); setMessage("");
    const key = postKeyRef.current ?? crypto.randomUUID();
    postKeyRef.current = key;
    let error: { code?: string; message?: string } | null;
    try {
      ({ error } = await client.rpc("post_purchase_receipt", {
        p_receipt_id: receiptToPost.id, p_idempotency_key: `POST-RECEIPT-${key}`,
        p_request_fingerprint: postFingerprintRef.current
          ?? JSON.stringify({ receiptId: receiptToPost.id, receiptNo: receiptToPost.receipt_no }),
      }));
    } catch {
      setMessage("入庫送出結果尚未確認；請保留同一草稿並使用相同資料重試，不要另建一筆。");
      setBusy(false);
      return false;
    }
    if (error) {
      setMessage(safeSupabaseMutationErrorMessage(error, "入庫送出失敗；請使用相同草稿重試。"));
      setBusy(false);
      return false;
    }
    setReceipt({ ...receiptToPost, status: "POSTED" });
    postKeyRef.current = null;
    postFingerprintRef.current = null;
    notifyInventoryDataChanged();
    setMessage("入庫已完成；合格數量已依交易寫入總倉，採購單進度同步更新。");
    setBusy(false);
    return true;
  }

  async function completeReceipt() {
    if (receipt) {
      await postReceipt(receipt);
      return;
    }
    if (!identityReady || dataReadBlocked || !client || !selectedLine || !receiptNo.trim()
      || deliveredQuantity < 0 || acceptedQuantity < 0 || rejectedQuantity < 0) {
      setMessage("請選擇採購單明細、填寫單號與不小於 0 的驗收數量。");
      return;
    }

    setBusy(true);
    setMessage("");
    const createKey = createKeyRef.current ?? crypto.randomUUID();
    const postKey = postKeyRef.current ?? crypto.randomUUID();
    createKeyRef.current = createKey;
    postKeyRef.current = postKey;
    const createFingerprint = JSON.stringify({
      lineId: selectedLine.id,
      receiptNo: receiptNo.trim(),
      deliveredQuantity,
      acceptedQuantity,
      rejectedQuantity,
      rejectionReason: rejectionReason.trim(),
      receivedOn,
    });
    const postFingerprint = JSON.stringify({
      receiptNo: receiptNo.trim(),
      lineId: selectedLine.id,
      deliveredQuantity,
      acceptedQuantity,
      rejectedQuantity,
      receivedOn,
    });
    postFingerprintRef.current = postFingerprint;
    const rpc = (client as unknown as { rpc: PurchaseReceiptRpcCall }).rpc.bind(client);
    const result = await completePurchaseReceipt(rpc, {
      receiptNo: receiptNo.trim(),
      purchaseOrderLineId: selectedLine.id,
      deliveredQuantity,
      acceptedQuantity,
      rejectedQuantity,
      rejectionReason: rejectionReason.trim() || null,
      receivedOn,
      createIdempotencyKey: `RECEIPT-DRAFT-${createKey}`,
      createRequestFingerprint: createFingerprint,
      postIdempotencyKey: `POST-RECEIPT-${postKey}`,
      postRequestFingerprint: postFingerprint,
    }, client);

    if (result.receipt?.status === "DRAFT") {
      setReceipt(result.receipt);
      createKeyRef.current = null;
      setMessage(result.error
        ? safeSupabaseMutationErrorMessage(result.error, "入庫草稿已保存，但送出尚未完成；請使用同一草稿重試。")
        : "入庫草稿已保存，但過帳結果尚未確認；請保留同一草稿並重試。",
      );
      setBusy(false);
      return;
    }

    if (result.error || result.failureStage || !result.receipt) {
      setMessage(result.error
        ? safeSupabaseMutationErrorMessage(result.error, "入庫完成狀態尚未確認；請保留目前資料並用相同內容重試。")
        : "入庫完成狀態尚未確認；請保留目前資料並用相同內容重試。",
      );
      setBusy(false);
      return;
    }

    setReceipt(result.receipt);
    createKeyRef.current = null;
    postKeyRef.current = null;
    postFingerprintRef.current = null;
    notifyInventoryDataChanged();
    setMessage("入庫已完成；合格數量已依交易寫入總倉，採購單進度同步更新。");
    setBusy(false);
  }

  async function updateDraft() {
    if (!identityReady || dataReadBlocked || !client || !receipt || receipt.status !== "DRAFT") return;
    setBusy(true); setMessage("");
    const key = createKeyRef.current ?? crypto.randomUUID();
    createKeyRef.current = key;
    const { data, error } = await client.rpc("update_purchase_receipt_draft", {
      p_receipt_id: receipt.id, p_delivered_quantity: deliveredQuantity, p_accepted_quantity: acceptedQuantity,
      p_rejected_quantity: rejectedQuantity, p_rejection_reason: rejectionReason.trim() || null,
      p_received_on: receivedOn, p_idempotency_key: `RECEIPT-UPDATE-${key}`,
      p_request_fingerprint: JSON.stringify({ receiptId: receipt.id, deliveredQuantity, acceptedQuantity, rejectedQuantity, rejectionReason: rejectionReason.trim(), receivedOn }),
    });
    if (error) setMessage(safeSupabaseMutationErrorMessage(error, "入庫草稿更新失敗；請使用相同草稿重試。"));
    else { setReceipt(data as Receipt); setMessage("入庫草稿已更新；完成分類後即可送出。"); createKeyRef.current = null; }
    setBusy(false);
  }

  if (!client) return <section className="panel import-panel" aria-label="採購入庫"><div className="panel-heading"><div><p className="eyebrow">13 / RECEIPT</p><h2>採購入庫</h2></div><span className="status-pill">預覽模式</span></div><p className="auth-message">登入 WAREHOUSE 帳號後，選擇採購單、登記到貨／合格／拒收數量並在實物確認後送出。</p></section>;
  return <section className="panel import-panel" aria-label="採購入庫" aria-busy={dataLoading || busy}>
    <div className="panel-heading"><div><p className="eyebrow">13 / RECEIPT</p><h2>採購入庫</h2></div><span className="status-pill">總倉入庫</span></div>
    <p className="auth-message">草稿可先保存尚未完成的驗收數量；確認送出後，系統才會檢查到貨量分類並寫入總倉庫存。採購單未到量、單據狀態與品號鎖會在送出時再次確認。</p>
    {dataLoading ? <p className="sr-only" role="status" aria-live="polite">{ordersLoading ? "正在載入可入庫採購單…" : "正在載入採購單明細…"}</p> : null}
    <div className="form-grid">
      <label className="field"><span>採購單</span><select value={dataReadBlocked ? "" : orderId} onChange={(event) => chooseOrder(event.target.value)} disabled={busy || dataReadBlocked || Boolean(activeReceipt)}><option value="">請選擇</option>{visibleOrders.map((order) => <option key={order.id} value={order.id}>{order.po_no}｜{order.supplier_code_snapshot}｜{workflowStatusLabel(order.status)}</option>)}</select></label>
      <label className="field"><span>採購單明細</span><select value={dataReadBlocked ? "" : lineId} onChange={(event) => chooseLine(event.target.value)} disabled={busy || dataReadBlocked || Boolean(activeReceipt) || lineSelectionLoading || !selectedOrder}><option value="">{linesLoading ? "載入明細中…" : ordersLoading && !selectedOrder ? "載入採購單中…" : "請選擇"}</option>{visibleLines.map((line) => <option key={line.id} value={line.id}>{line.item_code_snapshot}｜{line.item_name_snapshot}｜訂購 {line.ordered_quantity}</option>)}</select></label>
      <div className="metric"><span>供應商／品號</span><strong>{selectedOrder?.supplier_code_snapshot ?? "—"}／{selectedLine?.item_code_snapshot ?? "—"}</strong><small>{selectedOrder?.supplier_name_snapshot ?? "請先選擇採購單明細"}</small></div>
      <label className="field"><span>入庫單號</span><input value={receiptNo} onChange={(event) => { resetOperationKeys(); setReceiptNo(event.target.value); }} maxLength={80} disabled={busy || Boolean(activeReceipt)} placeholder="例如 GRN-2026-001" /></label>
      <label className="field"><span>到貨日期</span><input type="date" value={receivedOn} onChange={(event) => { resetOperationKeys(); setReceivedOn(event.target.value); }} disabled={busy || activeReceipt?.status === "POSTED"} /></label>
      <label className="field"><span>到貨量</span><input type="number" min={0} value={deliveredQuantity} onChange={(event) => { resetOperationKeys(); setDeliveredQuantity(Math.max(0, Number(event.target.value) || 0)); }} disabled={busy || activeReceipt?.status === "POSTED"} /></label>
      <label className="field"><span>合格量</span><input type="number" min={0} value={acceptedQuantity} onChange={(event) => { resetOperationKeys(); setAcceptedQuantity(Math.max(0, Number(event.target.value) || 0)); }} disabled={busy || activeReceipt?.status === "POSTED"} /></label>
      <label className="field"><span>拒收量</span><input type="number" min={0} value={rejectedQuantity} onChange={(event) => { resetOperationKeys(); setRejectedQuantity(Math.max(0, Number(event.target.value) || 0)); }} disabled={busy || activeReceipt?.status === "POSTED"} /></label>
      <div className="metric"><span>分類檢查</span><strong>{acceptedQuantity + rejectedQuantity}／{deliveredQuantity}</strong><small>{quantityBalanced ? "數量平衡" : "合格＋拒收必須等於到貨"}</small></div>
    </div>
    <label className="field reason-field"><span>拒收理由（拒收量大於 0 時送出前必填）</span><input value={rejectionReason} onChange={(event) => { resetOperationKeys(); setRejectionReason(event.target.value); }} maxLength={500} disabled={busy || activeReceipt?.status === "POSTED"} placeholder="例如：尺寸／布料不符" /></label>
    <WorkflowActionBar
      primary={{
        onClick: () => void completeReceipt(),
        busy,
        busyLabel: "處理中…",
        disabled: busy || dataReadBlocked || !selectedLine || !receiptNo.trim() || activeReceipt?.status === "POSTED" || !quantityBalanced || (rejectedQuantity > 0 && !rejectionReason.trim()),
        label: activeReceipt?.status === "DRAFT" ? "確認並送出入庫" : activeReceipt?.status === "POSTED" ? "已完成" : "確認並完成入庫",
      }}
      secondary={!activeReceipt
        ? <button className="secondary-button" type="button" onClick={() => void createDraft()} disabled={busy || dataReadBlocked || Boolean(activeReceipt) || !selectedLine}>{busy ? "建立中…" : "先保存入庫草稿"}</button>
        : activeReceipt.status === "DRAFT"
          ? <button className="secondary-button" type="button" onClick={() => void updateDraft()} disabled={busy}>{busy ? "更新中…" : "保存草稿修改"}</button>
          : <button className="secondary-button" type="button" onClick={startNextReceipt} disabled={busy}>處理下一筆</button>}
    />
    {activeReceipt ? <p className="success-note">入庫單 {activeReceipt.receipt_no}／{workflowStatusLabel(activeReceipt.status)}。{activeReceipt.status === "DRAFT" ? "請完成實物核對後即可送出。" : "此入庫單已鎖定，不能再次修改。"}</p> : null}
    {message ? <p className={message.includes("已") ? "success-note" : "auth-message"} role="status">{message}</p> : null}
  </section>;
}
