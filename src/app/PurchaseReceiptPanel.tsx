"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "@/src/lib/supabase-browser";

type PurchaseOrder = { id: string; po_no: string; supplier_code_snapshot: string; supplier_name_snapshot: string; status: string };
type PurchaseOrderLine = { id: string; purchase_order_id: string; item_code_snapshot: string; item_name_snapshot: string; size_snapshot: string | null; unit_snapshot: string; ordered_quantity: number };
type Receipt = { id: string; receipt_no: string; purchase_order_id: string; status: "DRAFT" | "POSTED"; received_on: string };

function taipeiToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
}

export default function PurchaseReceiptPanel() {
  const client = getSupabaseBrowserClient();
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [lines, setLines] = useState<PurchaseOrderLine[]>([]);
  const [lineId, setLineId] = useState("");
  const [receiptNo, setReceiptNo] = useState("");
  const [receivedOn, setReceivedOn] = useState(taipeiToday());
  const [deliveredQuantity, setDeliveredQuantity] = useState(0);
  const [acceptedQuantity, setAcceptedQuantity] = useState(0);
  const [rejectedQuantity, setRejectedQuantity] = useState(0);
  const [rejectionReason, setRejectionReason] = useState("");
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const createKeyRef = useRef<string | null>(null);
  const postKeyRef = useRef<string | null>(null);

  const selectedLine = useMemo(() => lines.find((line) => line.id === lineId), [lines, lineId]);
  const selectedOrder = useMemo(() => orders.find((order) => order.id === selectedLine?.purchase_order_id), [orders, selectedLine]);
  const quantityBalanced = deliveredQuantity > 0 && acceptedQuantity >= 0 && rejectedQuantity >= 0 && acceptedQuantity + rejectedQuantity === deliveredQuantity;

  useEffect(() => {
    if (!client) return;
    const supabase = client;
    let active = true;
    async function load() {
      const orderResult = await supabase.from("purchase_orders")
        .select("id,po_no,supplier_code_snapshot,supplier_name_snapshot,status")
        .in("status", ["ORDERED", "PARTIALLY_RECEIVED", "REOPENED"])
        .order("po_no");
      if (!active) return;
      if (orderResult.error) { setMessage("採購單載入失敗，請確認 WAREHOUSE 角色與 RLS 權限。"); return; }
      const loadedOrders = (orderResult.data ?? []) as PurchaseOrder[];
      const orderIds = loadedOrders.map((order) => order.id);
      const lineResult = orderIds.length > 0
        ? await supabase.from("purchase_order_lines").select("id,purchase_order_id,item_code_snapshot,item_name_snapshot,size_snapshot,unit_snapshot,ordered_quantity").in("purchase_order_id", orderIds).order("line_no")
        : { data: [], error: null };
      if (!active) return;
      if (lineResult.error) { setMessage("採購單明細載入失敗，請重新整理。"); return; }
      const loadedLines = (lineResult.data ?? []) as PurchaseOrderLine[];
      setOrders(loadedOrders); setLines(loadedLines);
      if (loadedLines[0]) setLineId(loadedLines[0].id);
    }
    void load();
    return () => { active = false; };
  }, [client]);

  function resetOperationKeys() { createKeyRef.current = null; postKeyRef.current = null; }

  function chooseLine(nextId: string) {
    resetOperationKeys();
    setLineId(nextId); setReceipt(null); setReceiptNo(""); setDeliveredQuantity(0); setAcceptedQuantity(0); setRejectedQuantity(0); setRejectionReason("");
  }

  async function createDraft() {
    if (!client || !selectedLine || !receiptNo.trim() || deliveredQuantity < 0 || acceptedQuantity < 0 || rejectedQuantity < 0) {
      setMessage("請選擇採購單明細、填寫單號與不小於 0 的暫存數量。"); return;
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
    if (error) setMessage(`入庫草稿建立失敗：${error.message}`);
    else { setReceipt(data as Receipt); setMessage("已建立入庫草稿；確認實物與單據無誤後才能 POST 入庫。"); createKeyRef.current = null; }
    setBusy(false);
  }

  async function postReceipt() {
    if (!client || !receipt) { setMessage("請先建立入庫草稿。"); return; }
    setBusy(true); setMessage("");
    const key = postKeyRef.current ?? crypto.randomUUID();
    postKeyRef.current = key;
    const { error } = await client.rpc("post_purchase_receipt", {
      p_receipt_id: receipt.id, p_idempotency_key: `POST-RECEIPT-${key}`,
      p_request_fingerprint: JSON.stringify({ receiptId: receipt.id, receiptNo: receipt.receipt_no }),
    });
    if (error) setMessage(`入庫 POST 失敗：${error.message}`);
    else { setReceipt({ ...receipt, status: "POSTED" }); setMessage("入庫已 POST；合格數量已依交易寫入總倉，採購單進度同步更新。"); postKeyRef.current = null; }
    setBusy(false);
  }

  async function updateDraft() {
    if (!client || !receipt || receipt.status !== "DRAFT") return;
    setBusy(true); setMessage("");
    const key = createKeyRef.current ?? crypto.randomUUID();
    createKeyRef.current = key;
    const { data, error } = await client.rpc("update_purchase_receipt_draft", {
      p_receipt_id: receipt.id, p_delivered_quantity: deliveredQuantity, p_accepted_quantity: acceptedQuantity,
      p_rejected_quantity: rejectedQuantity, p_rejection_reason: rejectionReason.trim() || null,
      p_received_on: receivedOn, p_idempotency_key: `RECEIPT-UPDATE-${key}`,
      p_request_fingerprint: JSON.stringify({ receiptId: receipt.id, deliveredQuantity, acceptedQuantity, rejectedQuantity, rejectionReason: rejectionReason.trim(), receivedOn }),
    });
    if (error) setMessage(`入庫草稿更新失敗：${error.message}`);
    else { setReceipt(data as Receipt); setMessage("入庫草稿已更新；完成分類後即可 POST。"); createKeyRef.current = null; }
    setBusy(false);
  }

  if (!client) return <section className="panel import-panel" aria-label="採購入庫"><div className="panel-heading"><div><p className="eyebrow">13 / RECEIPT POST</p><h2>採購入庫</h2></div><span className="status-pill">預覽模式</span></div><p className="auth-message">登入 WAREHOUSE 帳號後，選擇採購單、登記到貨／合格／拒收數量並在實物確認後 POST。</p></section>;
  return <section className="panel import-panel" aria-label="採購入庫">
    <div className="panel-heading"><div><p className="eyebrow">13 / RECEIPT POST</p><h2>採購入庫</h2></div><span className="status-pill">總倉入庫</span></div>
    <p className="auth-message">草稿可先保存尚未完成的驗收數量；只有 POST 成功後，系統才會強制到貨量完整分類，並以不可重複的庫存流水寫入總倉。系統會重驗採購單未到量、PO 狀態與品號鎖。</p>
    <div className="form-grid">
      <label className="field"><span>採購單明細</span><select value={lineId} onChange={(event) => chooseLine(event.target.value)} disabled={busy || Boolean(receipt)}><option value="">請選擇</option>{lines.map((line) => { const order = orders.find((row) => row.id === line.purchase_order_id); return <option key={line.id} value={line.id}>{order?.po_no}｜{order?.supplier_code_snapshot}｜{line.item_code_snapshot}｜訂購 {line.ordered_quantity}</option>; })}</select></label>
      <div className="metric"><span>供應商／品號</span><strong>{selectedOrder?.supplier_code_snapshot ?? "—"}／{selectedLine?.item_code_snapshot ?? "—"}</strong><small>{selectedOrder?.supplier_name_snapshot ?? "請先選擇採購單明細"}</small></div>
      <label className="field"><span>入庫單號</span><input value={receiptNo} onChange={(event) => { resetOperationKeys(); setReceiptNo(event.target.value); }} maxLength={80} disabled={busy || Boolean(receipt)} placeholder="例如 GRN-2026-001" /></label>
      <label className="field"><span>到貨日期</span><input type="date" value={receivedOn} onChange={(event) => { resetOperationKeys(); setReceivedOn(event.target.value); }} disabled={busy || receipt?.status === "POSTED"} /></label>
      <label className="field"><span>到貨量</span><input type="number" min={0} value={deliveredQuantity} onChange={(event) => { resetOperationKeys(); setDeliveredQuantity(Math.max(0, Number(event.target.value) || 0)); }} disabled={busy || receipt?.status === "POSTED"} /></label>
      <label className="field"><span>合格量</span><input type="number" min={0} value={acceptedQuantity} onChange={(event) => { resetOperationKeys(); setAcceptedQuantity(Math.max(0, Number(event.target.value) || 0)); }} disabled={busy || receipt?.status === "POSTED"} /></label>
      <label className="field"><span>拒收量</span><input type="number" min={0} value={rejectedQuantity} onChange={(event) => { resetOperationKeys(); setRejectedQuantity(Math.max(0, Number(event.target.value) || 0)); }} disabled={busy || receipt?.status === "POSTED"} /></label>
      <div className="metric"><span>分類檢查</span><strong>{acceptedQuantity + rejectedQuantity}／{deliveredQuantity}</strong><small>{quantityBalanced ? "數量平衡" : "合格＋拒收必須等於到貨"}</small></div>
    </div>
    <label className="field reason-field"><span>拒收理由（拒收量大於 0 時 POST 前必填）</span><input value={rejectionReason} onChange={(event) => { resetOperationKeys(); setRejectionReason(event.target.value); }} maxLength={500} disabled={busy || receipt?.status === "POSTED"} placeholder="例如：尺寸／布料不符" /></label>
    <div className="button-row"><button className="primary-button" type="button" onClick={() => void createDraft()} disabled={busy || Boolean(receipt) || !selectedLine}>{busy ? "建立中…" : "建立入庫草稿"}</button>{receipt?.status === "DRAFT" ? <button className="secondary-button" type="button" onClick={() => void updateDraft()} disabled={busy}>{busy ? "更新中…" : "保存草稿修改"}</button> : null}{receipt ? <button className="secondary-button" type="button" onClick={() => void postReceipt()} disabled={busy || receipt.status === "POSTED" || !quantityBalanced || (rejectedQuantity > 0 && !rejectionReason.trim())}>{busy ? "POST 中…" : receipt.status === "POSTED" ? "已 POST" : "確認並 POST 入庫"}</button> : null}</div>
    {receipt ? <p className="success-note">入庫單 {receipt.receipt_no}／狀態 {receipt.status}。{receipt.status === "DRAFT" ? "請完成實物核對後再 POST。" : "此入庫單已鎖定，不能再次修改。"}</p> : null}
    {message ? <p className={message.includes("已") ? "success-note" : "auth-message"} role="status">{message}</p> : null}
  </section>;
}
