"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import CorrectionHistoryTable from "@/src/app/CorrectionHistoryTable";
import type { CorrectionHistoryRow } from "@/src/domain/correction-history";
import { getSupabaseBrowserClient } from "@/src/lib/supabase-browser";
import { validateWarehouseTransferCorrectionInput } from "@/src/domain/warehouse-transfer-correction";

type Kind = "SHIPMENT" | "REPLENISHMENT";
type Source = { kind: Kind; lineId: string; parentId: string; parentNo: string; itemCode: string; itemName: string; actual: number; requested: number };
type Correction = { id: string; correction_no: string; status: "DRAFT" | "POSTED" };
type History = { id: string; correction_no: string; status: string; reason: string; delta: number; posted_at: string | null };
const PREFIX = "uniform:warehouse-transfer-correction";

export default function WarehouseTransferCorrectionPanel() {
  const client = getSupabaseBrowserClient();
  const [sources, setSources] = useState<Source[]>([]);
  const [sourceKey, setSourceKey] = useState("");
  const [correctionNo, setCorrectionNo] = useState("");
  const [reason, setReason] = useState("");
  const [delta, setDelta] = useState(0);
  const [correction, setCorrection] = useState<Correction | null>(null);
  const [history, setHistory] = useState<History[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const createKeyRef = useRef<string | null>(null);
  const postKeyRef = useRef<string | null>(null);
  const recoveredSourceRef = useRef<string | null>(null);
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
    if (!client) return;
    const supabase = client;
    const createKey = window.localStorage.getItem(`${PREFIX}:create-key`);
    const postKey = window.localStorage.getItem(`${PREFIX}:post-key`);
    const savedId = window.localStorage.getItem(`${PREFIX}:id`);
    if (createKey) createKeyRef.current = createKey;
    if (postKey) postKeyRef.current = postKey;
    let active = true;
    async function recover() {
      if (!createKey && !postKey && !savedId) return;
      const { data, error } = await supabase.rpc("get_warehouse_transfer_correction_status", {
        p_correction_note_id: savedId,
        p_create_idempotency_key: createKey ? `CREATE-WAREHOUSE-TRANSFER-CORRECTION-${createKey}` : null,
        p_post_idempotency_key: postKey ? `POST-WAREHOUSE-TRANSFER-CORRECTION-${postKey}` : null,
      });
      if (!active) return;
      if (error) { setMessage("調撥更正結果尚未確認；請稍後以相同操作重試。"); return; }
      if (data?.id) {
        setCorrection(data as Correction); window.localStorage.setItem(`${PREFIX}:id`, data.id as string);
        const { data: line } = await supabase.from("warehouse_transfer_correction_lines").select("original_shipment_line_id,original_replenishment_line_id").eq("correction_note_id", data.id).maybeSingle();
        if (line) { recoveredSourceRef.current = line.original_shipment_line_id ? `SHIPMENT:${line.original_shipment_line_id}` : `REPLENISHMENT:${line.original_replenishment_line_id}`; if (active) setSourceKey(recoveredSourceRef.current); }
        setMessage("已恢復上一筆調撥更正；請確認狀態後繼續。");
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
      const [shipments, replenishments] = await Promise.all([
        supabase.from("warehouse_shipments").select("id,shipment_no").eq("status", "POSTED").order("shipment_no", { ascending: false }),
        supabase.from("replenishment_requests").select("id,request_no").eq("status", "SHIPPED").order("request_no", { ascending: false }),
      ]);
      const shipmentRows = (shipments.data ?? []) as Array<{ id: string; shipment_no: string }>;
      const replenishmentRows = (replenishments.data ?? []) as Array<{ id: string; request_no: string }>;
      const [shipmentLines, replenishmentLines] = await Promise.all([
        shipmentRows.length ? supabase.from("warehouse_shipment_lines").select("id,shipment_id,item_code_snapshot,item_name_snapshot,actual_transfer_quantity,requested_transfer_quantity_snapshot").in("shipment_id", shipmentRows.map((row) => row.id)) : Promise.resolve({ data: [], error: null }),
        replenishmentRows.length ? supabase.from("replenishment_request_lines").select("id,request_id,item_code_snapshot,item_name_snapshot,actual_transfer_quantity,requested_quantity").in("request_id", replenishmentRows.map((row) => row.id)) : Promise.resolve({ data: [], error: null }),
      ]);
      if (!active) return;
      const loaded: Source[] = [
        ...((shipmentLines.data ?? []) as Array<{ id: string; shipment_id: string; item_code_snapshot: string; item_name_snapshot: string; actual_transfer_quantity: number; requested_transfer_quantity_snapshot: number }>).filter((line) => line.actual_transfer_quantity != null).map((line) => ({ kind: "SHIPMENT" as const, lineId: line.id, parentId: line.shipment_id, parentNo: shipmentRows.find((row) => row.id === line.shipment_id)?.shipment_no ?? line.shipment_id, itemCode: line.item_code_snapshot, itemName: line.item_name_snapshot, actual: line.actual_transfer_quantity, requested: line.requested_transfer_quantity_snapshot })),
        ...((replenishmentLines.data ?? []) as Array<{ id: string; request_id: string; item_code_snapshot: string; item_name_snapshot: string; actual_transfer_quantity: number; requested_quantity: number }>).filter((line) => line.actual_transfer_quantity != null).map((line) => ({ kind: "REPLENISHMENT" as const, lineId: line.id, parentId: line.request_id, parentNo: replenishmentRows.find((row) => row.id === line.request_id)?.request_no ?? line.request_id, itemCode: line.item_code_snapshot, itemName: line.item_name_snapshot, actual: line.actual_transfer_quantity, requested: line.requested_quantity })),
      ];
      setSources(loaded);
      const recovered = recoveredSourceRef.current;
      if (recovered && loaded.some((source) => `${source.kind}:${source.lineId}` === recovered)) setSourceKey(recovered);
      else if (!window.localStorage.getItem(`${PREFIX}:id`)) setSourceKey(loaded[0] ? `${loaded[0].kind}:${loaded[0].lineId}` : "");
    }
    void load();
    return () => { active = false; };
  }, [client]);

  useEffect(() => {
    if (!client || !selected) return;
    const supabase = client;
    const source = selected;
    let active = true;
    async function loadHistory() {
      const parentField = source.kind === "SHIPMENT" ? "original_warehouse_shipment_id" : "original_replenishment_request_id";
      const { data: notes } = await supabase.from("correction_notes").select("id,correction_no,status,reason,posted_at").eq("correction_kind", "WAREHOUSE_TRANSFER").eq(parentField, source.parentId).order("id", { ascending: false });
      if (!active) return;
      const ids = (notes ?? []).map((note) => note.id as string);
      if (!ids.length) { setHistory([]); return; }
      const { data: lines } = await supabase.from("warehouse_transfer_correction_lines").select("correction_note_id,original_shipment_line_id,original_replenishment_line_id,transfer_quantity_delta").in("correction_note_id", ids);
      if (!active) return;
      const byNote = new Map((lines ?? []).filter((line) => (source.kind === "SHIPMENT" ? line.original_shipment_line_id : line.original_replenishment_line_id) === source.lineId).map((line) => [line.correction_note_id as string, line]));
      setHistory((notes ?? []).filter((note) => byNote.has(note.id as string)).map((note) => ({ id: note.id as string, correction_no: note.correction_no as string, status: note.status as string, reason: note.reason as string, delta: Number(byNote.get(note.id as string)?.transfer_quantity_delta ?? 0), posted_at: note.posted_at as string | null })));
    }
    void loadHistory();
    return () => { active = false; };
  }, [client, selected]);

  function resetKeys() { createKeyRef.current = null; postKeyRef.current = null; window.localStorage.removeItem(`${PREFIX}:create-key`); window.localStorage.removeItem(`${PREFIX}:post-key`); }
  async function createDraft() {
    const source = selected;
    if (!client || !source || validationError || !correctionNo.trim()) { setMessage(validationError ?? "請選擇已 POST 調撥／補庫明細、填寫單號與原因。"); return; }
    setBusy(true); setMessage("");
    const key = createKeyRef.current ?? crypto.randomUUID(); createKeyRef.current = key; window.localStorage.setItem(`${PREFIX}:create-key`, key);
    const { data, error } = await client.rpc("create_warehouse_transfer_correction_draft", { p_correction_no: correctionNo.trim(), p_source_kind: source.kind, p_source_line_id: source.lineId, p_transfer_quantity_delta: delta, p_reason: reason.trim(), p_note: null, p_idempotency_key: `CREATE-WAREHOUSE-TRANSFER-CORRECTION-${key}`, p_request_fingerprint: JSON.stringify({ sourceKind: source.kind, sourceLineId: source.lineId, correctionNo: correctionNo.trim(), delta, reason: reason.trim() }) });
    if (error || !data?.id) setMessage(`調撥更正結果尚未確認：${error?.message ?? "請使用相同操作重試"}`);
    else { setCorrection(data as Correction); window.localStorage.removeItem(`${PREFIX}:create-key`); createKeyRef.current = null; window.localStorage.setItem(`${PREFIX}:id`, data.id as string); setMessage("調撥更正草稿已建立；確認後再 POST。"); }
    setBusy(false);
  }
  async function postDraft() {
    if (!client || !correction || correction.status !== "DRAFT") return;
    setBusy(true); setMessage("");
    const key = postKeyRef.current ?? crypto.randomUUID(); postKeyRef.current = key; window.localStorage.setItem(`${PREFIX}:post-key`, key);
    const { data, error } = await client.rpc("post_warehouse_transfer_correction", { p_correction_note_id: correction.id, p_idempotency_key: `POST-WAREHOUSE-TRANSFER-CORRECTION-${key}`, p_request_fingerprint: JSON.stringify({ correctionId: correction.id, correctionNo: correction.correction_no }) });
    if (error || !data?.id) setMessage(`調撥更正 POST 結果尚未確認：${error?.message ?? "請使用相同操作重試"}`);
    else { setCorrection(data as Correction); window.localStorage.removeItem(`${PREFIX}:post-key`); postKeyRef.current = null; window.localStorage.setItem(`${PREFIX}:id`, correction.id); setMessage("調撥更正已 POST；總倉／人資倉雙邊餘額與流水已在同一交易更新。"); }
    setBusy(false);
  }
  function startAnother() { resetKeys(); window.localStorage.removeItem(`${PREFIX}:id`); setCorrection(null); setCorrectionNo(""); setReason(""); setDelta(0); setMessage("可建立下一筆調撥更正。"); }

  if (!client) return <section className="panel import-panel" aria-label="倉庫調撥更正"><div className="panel-heading"><div><p className="eyebrow">17 / TRANSFER CORRECTION</p><h2>倉庫調撥更正</h2></div><span className="status-pill">預覽模式</span></div><p className="auth-message">登入 WAREHOUSE 帳號後，可選擇已 POST 調撥／補庫明細建立更正。</p></section>;
  const effective = (selected?.actual ?? 0) + history.filter((item) => item.status === "POSTED").reduce((sum, item) => sum + item.delta, 0);
  return <section className="panel import-panel" aria-label="倉庫調撥更正">
    <div className="panel-heading"><div><p className="eyebrow">17 / TRANSFER CORRECTION</p><h2>倉庫調撥更正</h2></div><span className={`status-pill ${correction?.status === "POSTED" ? "success" : ""}`}>{correction?.status ?? "待建立"}</span></div>
    <p className="auth-message">更正只可指向已 POST 的發貨／補庫明細；正數代表總倉調入人資倉，負數代表沖回。RPC 會鎖品號、來源文件與兩倉餘額，保留原始流水並新增更正流水。</p>
    <div className="form-grid">
      <label className="field"><span>原始調撥明細</span><select value={sourceKey} onChange={(event) => { resetKeys(); window.localStorage.removeItem(`${PREFIX}:id`); setSourceKey(event.target.value); setCorrection(null); }} disabled={busy || Boolean(correction)}><option value="">請選擇</option>{sources.map((source) => <option key={`${source.kind}:${source.lineId}`} value={`${source.kind}:${source.lineId}`}>{source.kind === "SHIPMENT" ? "發貨" : "補庫"}｜{source.parentNo}｜{source.itemCode}｜原調撥 {source.actual}</option>)}</select></label>
      <div className="metric"><span>原始品號／有效調撥量</span><strong>{selected?.itemCode ?? "—"}／{effective}</strong><small>{selected?.itemName ?? "請先選擇明細"}；上限 {selected?.requested ?? "—"}</small></div>
      <label className="field"><span>更正單號</span><input value={correctionNo} onChange={(event) => { resetKeys(); setCorrectionNo(event.target.value); }} maxLength={80} disabled={busy || Boolean(correction)} placeholder="例如 WTC-2026-001" /></label>
      <label className="field"><span>調撥量差額</span><input type="number" step={1} value={delta} onChange={(event) => { resetKeys(); setDelta(Number(event.target.value) || 0); }} disabled={busy || Boolean(correction)} /></label>
    </div>
    <CorrectionHistoryTable ariaLabel="倉庫調撥更正歷史" rows={historyRows} deltaLabel="調撥差額" />
    <label className="field reason-field"><span>更正原因</span><input value={reason} onChange={(event) => { resetKeys(); setReason(event.target.value); }} maxLength={500} disabled={busy || Boolean(correction)} placeholder="例如：盤點後補登實際調撥" /></label>
    {validationError ? <p className="auth-message">{validationError}</p> : null}
    <div className="button-row"><button className="primary-button" type="button" onClick={() => void createDraft()} disabled={busy || Boolean(correction) || !selected}>{busy ? "建立中…" : "建立更正草稿"}</button>{correction?.status === "DRAFT" ? <button className="secondary-button" type="button" onClick={() => void postDraft()} disabled={busy}>{busy ? "POST 中…" : "確認並 POST 更正"}</button> : null}{correction ? <button className="secondary-button" type="button" onClick={startAnother} disabled={busy}>建立另一筆更正</button> : null}</div>
    {message ? <p className={message.includes("已") ? "success-note" : "auth-message"} role="status">{message}</p> : null}
  </section>;
}
