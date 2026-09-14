"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import CorrectionHistoryTable from "@/src/app/CorrectionHistoryTable";
import type { CorrectionHistoryRow } from "@/src/domain/correction-history";
import { getSupabaseBrowserClient } from "@/src/lib/supabase-browser";
import { validateStocktakeCorrectionInput } from "@/src/domain/stocktake-correction";

type Source = { lineId: string; stocktakeId: string; stocktakeNo: string; itemCode: string; itemName: string; warehouseId: string; counted: number; book: number };
type Correction = { id: string; correction_no: string; status: "DRAFT" | "POSTED" };
type History = { id: string; correction_no: string; status: string; reason: string; delta: number; posted_at: string | null };
const PREFIX = "uniform:stocktake-correction";

export default function StocktakeCorrectionPanel() {
  const client = getSupabaseBrowserClient();
  const [sources, setSources] = useState<Source[]>([]);
  const [sourceId, setSourceId] = useState("");
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
  const selected = useMemo(() => sources.find((source) => source.lineId === sourceId), [sources, sourceId]);
  const validationError = validateStocktakeCorrectionInput({ countedQuantityDelta: delta, reason });
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
      const { data, error } = await supabase.rpc("get_stocktake_correction_status", { p_correction_note_id: savedId, p_create_idempotency_key: createKey ? `CREATE-STOCKTAKE-CORRECTION-${createKey}` : null, p_post_idempotency_key: postKey ? `POST-STOCKTAKE-CORRECTION-${postKey}` : null });
      if (!active) return;
      if (error) { setMessage("盤點更正結果尚未確認；請稍後以相同操作重試。"); return; }
      if (data?.id) {
        setCorrection(data as Correction); window.localStorage.setItem(`${PREFIX}:id`, data.id as string);
        const { data: line } = await supabase.from("stocktake_correction_lines").select("original_stocktake_line_id").eq("correction_note_id", data.id).maybeSingle();
        if (line?.original_stocktake_line_id) { recoveredSourceRef.current = line.original_stocktake_line_id as string; if (active) setSourceId(recoveredSourceRef.current); }
        setMessage("已恢復上一筆盤點更正；請確認狀態後繼續。");
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
      const { data: stocktakes } = await supabase.from("stocktakes").select("id,stocktake_no,warehouse_id").eq("status", "POSTED").order("stocktake_no", { ascending: false });
      const rows = (stocktakes ?? []) as Array<{ id: string; stocktake_no: string; warehouse_id: string }>;
      const { data: lines } = rows.length ? await supabase.from("stocktake_lines").select("id,stocktake_id,item_code_snapshot,item_name_snapshot,item_id,counted_quantity,book_quantity_snapshot").in("stocktake_id", rows.map((row) => row.id)) : { data: [] as unknown[] };
      if (!active) return;
      const loaded = ((lines ?? []) as Array<{ id: string; stocktake_id: string; item_code_snapshot: string; item_name_snapshot: string; item_id: string; counted_quantity: number; book_quantity_snapshot: number }>).map((line) => ({ lineId: line.id, stocktakeId: line.stocktake_id, stocktakeNo: rows.find((row) => row.id === line.stocktake_id)?.stocktake_no ?? line.stocktake_id, itemCode: line.item_code_snapshot, itemName: line.item_name_snapshot, warehouseId: rows.find((row) => row.id === line.stocktake_id)?.warehouse_id ?? "", counted: line.counted_quantity, book: line.book_quantity_snapshot }));
      setSources(loaded);
      if (recoveredSourceRef.current && loaded.some((source) => source.lineId === recoveredSourceRef.current)) setSourceId(recoveredSourceRef.current);
      else if (!window.localStorage.getItem(`${PREFIX}:id`)) setSourceId(loaded[0]?.lineId ?? "");
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
      const { data: notes } = await supabase.from("correction_notes").select("id,correction_no,status,reason,posted_at").eq("correction_kind", "STOCKTAKE").eq("original_stocktake_id", source.stocktakeId).order("id", { ascending: false });
      if (!active) return;
      const ids = (notes ?? []).map((note) => note.id as string);
      if (!ids.length) { setHistory([]); return; }
      const { data: lines } = await supabase.from("stocktake_correction_lines").select("correction_note_id,original_stocktake_line_id,counted_quantity_delta").in("correction_note_id", ids);
      if (!active) return;
      const byNote = new Map((lines ?? []).filter((line) => line.original_stocktake_line_id === source.lineId).map((line) => [line.correction_note_id as string, line]));
      setHistory((notes ?? []).filter((note) => byNote.has(note.id as string)).map((note) => ({ id: note.id as string, correction_no: note.correction_no as string, status: note.status as string, reason: note.reason as string, delta: Number(byNote.get(note.id as string)?.counted_quantity_delta ?? 0), posted_at: note.posted_at as string | null })));
    }
    void loadHistory();
    return () => { active = false; };
  }, [client, selected]);

  function resetKeys() { createKeyRef.current = null; postKeyRef.current = null; window.localStorage.removeItem(`${PREFIX}:create-key`); window.localStorage.removeItem(`${PREFIX}:post-key`); }
  async function createDraft() {
    if (!client || !selected || validationError || !correctionNo.trim()) { setMessage(validationError ?? "請選擇已 POST 盤點明細、填寫單號與原因。"); return; }
    setBusy(true); setMessage("");
    const key = createKeyRef.current ?? crypto.randomUUID(); createKeyRef.current = key; window.localStorage.setItem(`${PREFIX}:create-key`, key);
    const { data, error } = await client.rpc("create_stocktake_correction_draft", { p_correction_no: correctionNo.trim(), p_original_stocktake_line_id: selected.lineId, p_counted_quantity_delta: delta, p_reason: reason.trim(), p_note: null, p_idempotency_key: `CREATE-STOCKTAKE-CORRECTION-${key}`, p_request_fingerprint: JSON.stringify({ lineId: selected.lineId, correctionNo: correctionNo.trim(), delta, reason: reason.trim() }) });
    if (error || !data?.id) setMessage(`盤點更正結果尚未確認：${error?.message ?? "請使用相同操作重試"}`);
    else { setCorrection(data as Correction); window.localStorage.removeItem(`${PREFIX}:create-key`); createKeyRef.current = null; window.localStorage.setItem(`${PREFIX}:id`, data.id as string); setMessage("盤點更正草稿已建立；確認後再 POST。"); }
    setBusy(false);
  }
  async function postDraft() {
    if (!client || !correction || correction.status !== "DRAFT") return;
    setBusy(true); setMessage("");
    const key = postKeyRef.current ?? crypto.randomUUID(); postKeyRef.current = key; window.localStorage.setItem(`${PREFIX}:post-key`, key);
    const { data, error } = await client.rpc("post_stocktake_correction", { p_correction_note_id: correction.id, p_idempotency_key: `POST-STOCKTAKE-CORRECTION-${key}`, p_request_fingerprint: JSON.stringify({ correctionId: correction.id, correctionNo: correction.correction_no }) });
    if (error || !data?.id) setMessage(`盤點更正 POST 結果尚未確認：${error?.message ?? "請使用相同操作重試"}`);
    else { setCorrection(data as Correction); window.localStorage.removeItem(`${PREFIX}:post-key`); postKeyRef.current = null; window.localStorage.setItem(`${PREFIX}:id`, correction.id); setMessage("盤點更正已 POST；盤點流水、餘額與預留衝突已在同一交易處理。"); }
    setBusy(false);
  }
  function startAnother() { resetKeys(); window.localStorage.removeItem(`${PREFIX}:id`); setCorrection(null); setCorrectionNo(""); setReason(""); setDelta(0); setMessage("可建立下一筆盤點更正。"); }

  if (!client) return <section className="panel import-panel" aria-label="盤點更正"><div className="panel-heading"><div><p className="eyebrow">18 / STOCKTAKE CORRECTION</p><h2>盤點更正</h2></div><span className="status-pill">預覽模式</span></div><p className="auth-message">登入 HR 或 WAREHOUSE 帳號後，可選擇已 POST 盤點明細建立更正。</p></section>;
  const effective = (selected?.counted ?? 0) + history.filter((item) => item.status === "POSTED").reduce((sum, item) => sum + item.delta, 0);
  return <section className="panel import-panel" aria-label="盤點更正">
    <div className="panel-heading"><div><p className="eyebrow">18 / STOCKTAKE CORRECTION</p><h2>盤點更正</h2></div><span className={`status-pill ${correction?.status === "POSTED" ? "success" : ""}`}>{correction?.status ?? "待建立"}</span></div>
    <p className="auth-message">更正只可指向已 POST 盤點明細；差額只新增盤點更正流水，不改寫原始盤點。RPC 會鎖品號、盤點來源、兩倉餘額及受影響預留，重算有效實盤數量。</p>
    <div className="form-grid">
      <label className="field"><span>原始盤點明細</span><select value={sourceId} onChange={(event) => { resetKeys(); window.localStorage.removeItem(`${PREFIX}:id`); setSourceId(event.target.value); setCorrection(null); }} disabled={busy || Boolean(correction)}><option value="">請選擇</option>{sources.map((source) => <option key={source.lineId} value={source.lineId}>{source.stocktakeNo}｜{source.itemCode}｜帳面 {source.book}／實盤 {source.counted}</option>)}</select></label>
      <div className="metric"><span>原始品號／有效實盤量</span><strong>{selected?.itemCode ?? "—"}／{effective}</strong><small>{selected?.itemName ?? "請先選擇明細"}；原帳面 {selected?.book ?? "—"}</small></div>
      <label className="field"><span>更正單號</span><input value={correctionNo} onChange={(event) => { resetKeys(); setCorrectionNo(event.target.value); }} maxLength={80} disabled={busy || Boolean(correction)} placeholder="例如 STC-2026-001" /></label>
      <label className="field"><span>實盤量差額</span><input type="number" step={1} value={delta} onChange={(event) => { resetKeys(); setDelta(Number(event.target.value) || 0); }} disabled={busy || Boolean(correction)} /></label>
    </div>
    <CorrectionHistoryTable ariaLabel="盤點更正歷史" rows={historyRows} deltaLabel="實盤差額" />
    <label className="field reason-field"><span>更正原因</span><input value={reason} onChange={(event) => { resetKeys(); setReason(event.target.value); }} maxLength={500} disabled={busy || Boolean(correction)} placeholder="例如：複盤後發現漏盤" /></label>
    {validationError ? <p className="auth-message">{validationError}</p> : null}
    <div className="button-row"><button className="primary-button" type="button" onClick={() => void createDraft()} disabled={busy || Boolean(correction) || !selected}>{busy ? "建立中…" : "建立更正草稿"}</button>{correction?.status === "DRAFT" ? <button className="secondary-button" type="button" onClick={() => void postDraft()} disabled={busy}>{busy ? "POST 中…" : "確認並 POST 更正"}</button> : null}{correction ? <button className="secondary-button" type="button" onClick={startAnother} disabled={busy}>建立另一筆更正</button> : null}</div>
    {message ? <p className={message.includes("已") ? "success-note" : "auth-message"} role="status">{message}</p> : null}
  </section>;
}
