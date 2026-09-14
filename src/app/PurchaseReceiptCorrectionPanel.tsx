"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import CorrectionHistoryTable from "@/src/app/CorrectionHistoryTable";
import type { CorrectionHistoryRow } from "@/src/domain/correction-history";
import { getSupabaseBrowserClient } from "@/src/lib/supabase-browser";
import { validateReceiptCorrectionInput } from "@/src/domain/receipt-correction";

type Receipt = { id: string; receipt_no: string; purchase_order_id: string; received_on: string };
type ReceiptLine = { id: string; receipt_id: string; item_code_snapshot: string; item_name_snapshot: string; delivered_quantity: number; accepted_quantity: number; rejected_quantity: number };
type Correction = { id: string; correction_no: string; status: "DRAFT" | "POSTED"; original_purchase_receipt_id: string };
type CorrectionHistory = { id: string; correction_no: string; status: string; reason: string; delivered_quantity_delta: number; accepted_quantity_delta: number; rejected_quantity_delta: number; posted_at: string | null };

const STORAGE_PREFIX = "uniform:receipt-correction";

export default function PurchaseReceiptCorrectionPanel() {
  const client = getSupabaseBrowserClient();
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [lines, setLines] = useState<ReceiptLine[]>([]);
  const [lineId, setLineId] = useState("");
  const [correctionNo, setCorrectionNo] = useState("");
  const [reason, setReason] = useState("");
  const [deliveredDelta, setDeliveredDelta] = useState(0);
  const [acceptedDelta, setAcceptedDelta] = useState(0);
  const [rejectedDelta, setRejectedDelta] = useState(0);
  const [rejectionReason, setRejectionReason] = useState("");
  const [correction, setCorrection] = useState<Correction | null>(null);
  const [history, setHistory] = useState<CorrectionHistory[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const createKeyRef = useRef<string | null>(null);
  const postKeyRef = useRef<string | null>(null);
  const recoveredLineIdRef = useRef<string | null>(null);
  const selectedLine = useMemo(() => lines.find((line) => line.id === lineId), [lines, lineId]);
  const selectedReceipt = useMemo(() => receipts.find((receipt) => receipt.id === selectedLine?.receipt_id), [receipts, selectedLine]);
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
    if (!client) return;
    const supabase = client;
    const savedCreateKey = window.localStorage.getItem(`${STORAGE_PREFIX}:create-key`);
    const savedPostKey = window.localStorage.getItem(`${STORAGE_PREFIX}:post-key`);
    const savedCorrectionId = window.localStorage.getItem(`${STORAGE_PREFIX}:id`);
    if (savedCreateKey) createKeyRef.current = savedCreateKey;
    if (savedPostKey) postKeyRef.current = savedPostKey;
    let active = true;
    async function recover() {
      if (!savedCorrectionId && !savedCreateKey && !savedPostKey) return;
      const { data, error } = await supabase.rpc("get_purchase_receipt_correction_status", {
        p_correction_note_id: savedCorrectionId,
        p_create_idempotency_key: savedCreateKey ? `RECEIPT-CORRECTION-DRAFT-${savedCreateKey}` : null,
        p_post_idempotency_key: savedPostKey ? `POST-RECEIPT-CORRECTION-${savedPostKey}` : null,
      });
      if (!active) return;
      if (error) { setMessage("更正操作結果尚未確認；請稍後以相同操作重試。"); return; }
      if (data?.id) {
        const recovered = data as Correction;
        setCorrection(recovered);
        window.localStorage.setItem(`${STORAGE_PREFIX}:id`, recovered.id);
        const { data: line } = await supabase.from("purchase_receipt_correction_lines")
          .select("original_receipt_line_id").eq("correction_note_id", recovered.id).maybeSingle();
        if (line?.original_receipt_line_id) {
          recoveredLineIdRef.current = line.original_receipt_line_id as string;
          if (active) setLineId(line.original_receipt_line_id as string);
        }
        setMessage("已恢復上一筆更正操作；請確認狀態後繼續。");
      }
    }
    void recover();
    return () => { active = false; };
  }, [client]);

  useEffect(() => {
    if (!client) return;
    const supabase = client;
    let active = true;
    async function load() {
      const receiptResult = await supabase.from("purchase_receipts")
        .select("id,receipt_no,purchase_order_id,received_on")
        .eq("status", "POSTED")
        .order("receipt_no", { ascending: false });
      if (!active) return;
      if (receiptResult.error) { setMessage("已 POST 入庫單載入失敗，請確認 WAREHOUSE 角色與 RLS 權限。"); return; }
      const loadedReceipts = (receiptResult.data ?? []) as Receipt[];
      const receiptIds = loadedReceipts.map((receipt) => receipt.id);
      const lineResult = receiptIds.length > 0
        ? await supabase.from("purchase_receipt_lines").select("id,receipt_id,item_code_snapshot,item_name_snapshot,delivered_quantity,accepted_quantity,rejected_quantity").in("receipt_id", receiptIds).order("id")
        : { data: [], error: null };
      if (!active) return;
      if (lineResult.error) { setMessage("入庫明細載入失敗，請重新整理。"); return; }
      const loadedLines = (lineResult.data ?? []) as ReceiptLine[];
      setReceipts(loadedReceipts); setLines(loadedLines);
      const recoveredLineId = recoveredLineIdRef.current;
      if (recoveredLineId && loadedLines.some((line) => line.id === recoveredLineId)) setLineId(recoveredLineId);
      else if (!window.localStorage.getItem(`${STORAGE_PREFIX}:id`)) setLineId(loadedLines[0]?.id ?? "");
    }
    void load();
    return () => { active = false; };
  }, [client]);

  useEffect(() => {
    if (!client || !selectedReceipt || !selectedLine) return;
    const supabase = client;
    const receipt = selectedReceipt;
    const receiptLineId = selectedLine.id;
    let active = true;
    async function loadHistory() {
      const { data: notes, error: notesError } = await supabase.from("correction_notes")
        .select("id,correction_no,status,reason,posted_at")
        .eq("original_purchase_receipt_id", receipt.id).order("id", { ascending: false });
      if (notesError || !active) return;
      const noteRows = (notes ?? []) as Array<{ id: string; correction_no: string; status: string; reason: string; posted_at: string | null }>;
      const ids = noteRows.map((note) => note.id);
      if (ids.length === 0) { setHistory([]); return; }
      const { data: correctionLines } = await supabase.from("purchase_receipt_correction_lines")
        .select("correction_note_id,original_receipt_line_id,delivered_quantity_delta,accepted_quantity_delta,rejected_quantity_delta")
        .in("correction_note_id", ids);
      if (!active) return;
      const byNote = new Map((correctionLines ?? [])
        .filter((line) => line.original_receipt_line_id === receiptLineId)
        .map((line) => [line.correction_note_id as string, line]));
      setHistory(noteRows.filter((note) => byNote.has(note.id)).map((note) => {
        const line = byNote.get(note.id);
        return { id: note.id, correction_no: note.correction_no, status: note.status, reason: note.reason,
          delivered_quantity_delta: Number(line?.delivered_quantity_delta ?? 0),
          accepted_quantity_delta: Number(line?.accepted_quantity_delta ?? 0),
          rejected_quantity_delta: Number(line?.rejected_quantity_delta ?? 0), posted_at: note.posted_at };
      }));
    }
    void loadHistory();
    return () => { active = false; };
  }, [client, selectedReceipt, selectedLine]);

  function resetOperationKeys() {
    createKeyRef.current = null; postKeyRef.current = null;
    window.localStorage.removeItem(`${STORAGE_PREFIX}:create-key`);
    window.localStorage.removeItem(`${STORAGE_PREFIX}:post-key`);
  }
  function chooseLine(nextId: string) {
    resetOperationKeys(); window.localStorage.removeItem(`${STORAGE_PREFIX}:id`);
    setLineId(nextId); setCorrection(null); setCorrectionNo(""); setReason("");
    setDeliveredDelta(0); setAcceptedDelta(0); setRejectedDelta(0); setRejectionReason("");
  }
  function changeNumber(setter: (value: number) => void, value: string) {
    resetOperationKeys(); setter(Number(value) || 0);
  }

  async function createDraft() {
    if (!client || !selectedLine || !selectedReceipt) { setMessage("請先選擇已 POST 入庫單明細。"); return; }
    if (validationError || !correctionNo.trim()) { setMessage(validationError ?? "請填寫更正單號。"); return; }
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
    if (error || !data?.id) setMessage(`更正草稿結果尚未確認：${error?.message ?? "請使用相同操作重試"}`);
    else {
      const created = data as Correction;
      setCorrection(created); createKeyRef.current = null;
      window.localStorage.removeItem(`${STORAGE_PREFIX}:create-key`);
      window.localStorage.setItem(`${STORAGE_PREFIX}:id`, created.id);
      setMessage("更正草稿已建立；確認鎖定交易後再 POST。");
    }
    setBusy(false);
  }

  async function postDraft() {
    if (!client || !correction || correction.status !== "DRAFT") return;
    setBusy(true); setMessage("");
    const key = postKeyRef.current ?? crypto.randomUUID(); postKeyRef.current = key;
    window.localStorage.setItem(`${STORAGE_PREFIX}:post-key`, key);
    const { data, error } = await client.rpc("post_purchase_receipt_correction", {
      p_correction_note_id: correction.id, p_idempotency_key: `POST-RECEIPT-CORRECTION-${key}`,
      p_request_fingerprint: JSON.stringify({ correctionId: correction.id, correctionNo: correction.correction_no }),
    });
    if (error || !data?.id) setMessage(`更正 POST 結果尚未確認：${error?.message ?? "請使用相同操作重試"}`);
    else {
      const posted = data as Correction;
      setCorrection(posted); postKeyRef.current = null;
      window.localStorage.removeItem(`${STORAGE_PREFIX}:post-key`);
      window.localStorage.setItem(`${STORAGE_PREFIX}:id`, posted.id);
      setMessage("入庫更正已 POST；有效合格量、總倉餘額與採購單進度已在同一交易重算。");
    }
    setBusy(false);
  }

  function startAnother() {
    resetOperationKeys();
    window.localStorage.removeItem(`${STORAGE_PREFIX}:id`);
    setCorrection(null); setCorrectionNo(""); setReason("");
    setDeliveredDelta(0); setAcceptedDelta(0); setRejectedDelta(0); setRejectionReason("");
    setMessage("可建立下一筆入庫更正。");
  }

  if (!client) return <section className="panel import-panel" aria-label="採購入庫更正"><div className="panel-heading"><div><p className="eyebrow">14 / RECEIPT CORRECTION</p><h2>採購入庫更正</h2></div><span className="status-pill">預覽模式</span></div><p className="auth-message">登入 WAREHOUSE 帳號後，可選擇已 POST 入庫明細建立具理由的更正單。</p></section>;
  return <section className="panel import-panel" aria-label="採購入庫更正">
    <div className="panel-heading"><div><p className="eyebrow">14 / RECEIPT CORRECTION</p><h2>採購入庫更正</h2></div><span className={`status-pill ${correction?.status === "POSTED" ? "success" : ""}`}>{correction?.status ?? "待建立"}</span></div>
    <p className="auth-message">更正只可指向已 POST 的原始入庫明細；系統由受保護 RPC 鎖定品號、採購單與原入庫，再重算有效到貨／合格／拒收及總倉差額。更正 POST 後不可修改。</p>
    <div className="form-grid">
      <label className="field"><span>原始入庫明細</span><select value={lineId} onChange={(event) => chooseLine(event.target.value)} disabled={busy || Boolean(correction)}><option value="">請選擇</option>{lines.map((line) => { const receipt = receipts.find((row) => row.id === line.receipt_id); return <option key={line.id} value={line.id}>{receipt?.receipt_no}｜{line.item_code_snapshot}｜原到貨 {line.delivered_quantity}／合格 {line.accepted_quantity}／拒收 {line.rejected_quantity}</option>; })}</select></label>
      <div className="metric"><span>原始品號</span><strong>{selectedLine?.item_code_snapshot ?? "—"}</strong><small>{selectedLine?.item_name_snapshot ?? selectedReceipt?.receipt_no ?? "請先選擇明細"}</small></div>
      <label className="field"><span>更正單號</span><input value={correctionNo} onChange={(event) => { resetOperationKeys(); setCorrectionNo(event.target.value); }} maxLength={80} disabled={busy || Boolean(correction)} placeholder="例如 RTC-2026-001" /></label>
      <label className="field"><span>到貨量差額</span><input type="number" step={1} value={deliveredDelta} onChange={(event) => changeNumber(setDeliveredDelta, event.target.value)} disabled={busy || Boolean(correction)} /></label>
      <label className="field"><span>合格量差額</span><input type="number" step={1} value={acceptedDelta} onChange={(event) => changeNumber(setAcceptedDelta, event.target.value)} disabled={busy || Boolean(correction)} /></label>
      <label className="field"><span>拒收量差額</span><input type="number" step={1} value={rejectedDelta} onChange={(event) => changeNumber(setRejectedDelta, event.target.value)} disabled={busy || Boolean(correction)} /></label>
    </div>
    {selectedLine ? (() => {
      const posted = history.filter((item) => item.status === "POSTED");
      const effective = posted.reduce((totals, item) => ({
        delivered: totals.delivered + item.delivered_quantity_delta,
        accepted: totals.accepted + item.accepted_quantity_delta,
        rejected: totals.rejected + item.rejected_quantity_delta,
      }), { delivered: selectedLine.delivered_quantity, accepted: selectedLine.accepted_quantity, rejected: selectedLine.rejected_quantity });
      return <div className="metric"><span>目前有效數量（原始 + 已 POST 更正）</span><strong>到貨 {effective.delivered}／合格 {effective.accepted}／拒收 {effective.rejected}</strong><small>{posted.length > 0 ? `已有 ${posted.length} 筆已 POST 更正` : "尚無已 POST 更正"}</small></div>;
    })() : null}
    <CorrectionHistoryTable ariaLabel="採購入庫更正歷史" rows={historyRows} deltaLabel="差額（到貨／合格／拒收）" />
    <label className="field reason-field"><span>更正原因</span><input value={reason} onChange={(event) => { resetOperationKeys(); setReason(event.target.value); }} maxLength={500} disabled={busy || Boolean(correction)} placeholder="例如：供應商補送後更正原收貨紀錄" /></label>
    <label className="field reason-field"><span>拒收理由（拒收差額增加時必填）</span><input value={rejectionReason} onChange={(event) => { resetOperationKeys(); setRejectionReason(event.target.value); }} maxLength={500} disabled={busy || Boolean(correction)} placeholder="例如：補驗後判定瑕疵" /></label>
    {validationError ? <p className="auth-message">{validationError}</p> : null}
    <div className="button-row"><button className="primary-button" type="button" onClick={() => void createDraft()} disabled={busy || Boolean(correction) || !selectedLine}>{busy ? "建立中…" : "建立更正草稿"}</button>{correction?.status === "DRAFT" ? <button className="secondary-button" type="button" onClick={() => void postDraft()} disabled={busy}>{busy ? "POST 中…" : "確認並 POST 更正"}</button> : null}{correction ? <button className="secondary-button" type="button" onClick={startAnother} disabled={busy}>建立另一筆更正</button> : null}</div>
    {correction ? <p className="success-note">更正單 {correction.correction_no}／狀態 {correction.status}。{correction.status === "DRAFT" ? "確認數量差額與理由後再 POST。" : "更正已鎖定，不能再次修改。"}</p> : null}
    {message ? <p className={message.includes("已") ? "success-note" : "auth-message"} role="status">{message}</p> : null}
  </section>;
}
