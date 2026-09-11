"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import CorrectionHistoryTable from "@/src/app/CorrectionHistoryTable";
import type { CorrectionHistoryRow } from "@/src/domain/correction-history";
import { validateReturnCorrectionInput } from "@/src/domain/return-correction";
import { getSupabaseBrowserClient } from "@/src/lib/supabase-browser";

type ReturnNote = { id: string; return_no: string; original_hr_request_id: string; status: "DRAFT" | "POSTED" };
type ReturnLine = { id: string; return_note_id: string; original_issue_line_id: string; employee_no_snapshot: string | null; employee_name_snapshot: string | null; item_code_snapshot: string | null; item_name_snapshot: string | null; quantity: number; unit_snapshot: string | null };
type Correction = { id: string; correction_no: string; status: "DRAFT" | "POSTED"; original_return_note_id: string };
type History = { id: string; correction_no: string; status: string; reason: string; delta: number; posted_at: string | null };

const STORAGE_PREFIX = "uniform:return-correction";

export default function ReturnCorrectionPanel() {
  const client = getSupabaseBrowserClient();
  const [returns, setReturns] = useState<ReturnNote[]>([]);
  const [lines, setLines] = useState<ReturnLine[]>([]);
  const [lineId, setLineId] = useState("");
  const [correctionNo, setCorrectionNo] = useState("");
  const [delta, setDelta] = useState(0);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [correction, setCorrection] = useState<Correction | null>(null);
  const [history, setHistory] = useState<History[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const createKeyRef = useRef<string | null>(null);
  const postKeyRef = useRef<string | null>(null);
  const recoveredLineIdRef = useRef<string | null>(null);
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
    if (!client) return;
    const supabase = client;
    const savedCreateKey = window.localStorage.getItem(`${STORAGE_PREFIX}:create-key`);
    const savedPostKey = window.localStorage.getItem(`${STORAGE_PREFIX}:post-key`);
    const savedId = window.localStorage.getItem(`${STORAGE_PREFIX}:id`);
    if (savedCreateKey) createKeyRef.current = savedCreateKey;
    if (savedPostKey) postKeyRef.current = savedPostKey;
    let active = true;
    async function recover() {
      if (!savedCreateKey && !savedPostKey && !savedId) return;
      const { data, error } = await supabase.rpc("get_return_correction_status", {
        p_correction_note_id: savedId,
        p_create_idempotency_key: savedCreateKey ? `CREATE-RETURN-CORRECTION-${savedCreateKey}` : null,
        p_post_idempotency_key: savedPostKey ? `POST-RETURN-CORRECTION-${savedPostKey}` : null,
      });
      if (!active) return;
      if (error) { setMessage("退回更正結果尚未確認；請稍後以相同操作重試。"); return; }
      if (data?.id) {
        setCorrection(data as Correction);
        window.localStorage.setItem(`${STORAGE_PREFIX}:id`, String(data.id));
        const { data: source } = await supabase.from("return_correction_lines")
          .select("original_return_line_id").eq("correction_note_id", data.id).maybeSingle();
        if (source?.original_return_line_id) {
          recoveredLineIdRef.current = String(source.original_return_line_id);
          if (active) setLineId(String(source.original_return_line_id));
        }
        setMessage("已恢復上一筆退回更正操作；請確認狀態後繼續。");
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
      const result = await supabase.from("return_notes")
        .select("id,return_no,original_hr_request_id,status")
        .eq("status", "POSTED").order("id", { ascending: false });
      if (!active) return;
      if (result.error) { setMessage("已 POST 退回單載入失敗，請確認 HR 角色與 RLS 權限。"); return; }
      const loaded = (result.data ?? []) as ReturnNote[];
      const ids = loaded.map((row) => row.id);
      const lineResult = ids.length > 0
        ? await supabase.from("return_lines").select("id,return_note_id,original_issue_line_id,employee_no_snapshot,employee_name_snapshot,item_code_snapshot,item_name_snapshot,quantity,unit_snapshot").in("return_note_id", ids).order("line_no")
        : { data: [], error: null };
      if (!active) return;
      if (lineResult.error) { setMessage("退回明細載入失敗，請重新整理。"); return; }
      const loadedLines = (lineResult.data ?? []) as ReturnLine[];
      setReturns(loaded); setLines(loadedLines);
      const recovered = recoveredLineIdRef.current;
      if (recovered && loadedLines.some((line) => line.id === recovered)) setLineId(recovered);
      else if (!window.localStorage.getItem(`${STORAGE_PREFIX}:id`)) setLineId(loadedLines[0]?.id ?? "");
    }
    void load();
    return () => { active = false; };
  }, [client]);

  useEffect(() => {
    if (!client || !selectedLine) return;
    const supabase = client;
    const sourceLine = selectedLine;
    let active = true;
    async function loadHistory() {
      const { data: notes } = await supabase.from("correction_notes")
        .select("id,correction_no,status,reason,posted_at")
        .eq("original_return_note_id", sourceLine.return_note_id).order("id", { ascending: false });
      if (!active) return;
      const noteRows = (notes ?? []) as Array<{ id: string; correction_no: string; status: string; reason: string; posted_at: string | null }>;
      const ids = noteRows.map((row) => row.id);
      if (ids.length === 0) { setHistory([]); return; }
      const { data: correctionLines } = await supabase.from("return_correction_lines")
        .select("correction_note_id,original_return_line_id,return_quantity_delta")
        .in("correction_note_id", ids);
      if (!active) return;
      const byNote = new Map((correctionLines ?? [])
        .filter((line) => line.original_return_line_id === sourceLine.id)
        .map((line) => [String(line.correction_note_id), line]));
      setHistory(noteRows.filter((row) => byNote.has(row.id)).map((row) => ({
        id: row.id, correction_no: row.correction_no, status: row.status, reason: row.reason,
        delta: Number(byNote.get(row.id)?.return_quantity_delta ?? 0), posted_at: row.posted_at,
      })));
    }
    void loadHistory();
    return () => { active = false; };
  }, [client, selectedLine]);

  function resetKeys() {
    createKeyRef.current = null; postKeyRef.current = null;
    window.localStorage.removeItem(`${STORAGE_PREFIX}:create-key`);
    window.localStorage.removeItem(`${STORAGE_PREFIX}:post-key`);
  }
  function chooseLine(nextId: string) {
    if (correction) return;
    resetKeys(); window.localStorage.removeItem(`${STORAGE_PREFIX}:id`);
    setLineId(nextId); setDelta(0); setReason(""); setNote("");
  }
  async function createDraft() {
    if (!client || !selectedLine || !correctionNo.trim() || validationError) {
      setMessage(validationError ?? "請選擇已 POST 退回明細、填寫單號與原因。"); return;
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
    if (error || !data?.id) setMessage(`退回更正結果尚未確認：${error?.message ?? "請使用相同操作重試"}`);
    else {
      const created = data as Correction; setCorrection(created); createKeyRef.current = null;
      window.localStorage.removeItem(`${STORAGE_PREFIX}:create-key`); window.localStorage.setItem(`${STORAGE_PREFIX}:id`, created.id);
      setMessage("退回更正草稿已建立；確認後再 POST。");
    }
    setBusy(false);
  }
  async function postCorrection() {
    if (!client || !correction || correction.status !== "DRAFT") return;
    setBusy(true); setMessage("");
    const key = postKeyRef.current ?? crypto.randomUUID(); postKeyRef.current = key;
    window.localStorage.setItem(`${STORAGE_PREFIX}:post-key`, key);
    const { data, error } = await client.rpc("post_return_correction", {
      p_correction_note_id: correction.id, p_idempotency_key: `POST-RETURN-CORRECTION-${key}`,
      p_request_fingerprint: JSON.stringify({ correctionId: correction.id, correctionNo: correction.correction_no }),
    });
    if (error || !data?.id) setMessage(`退回更正結果尚未確認：${error?.message ?? "請使用相同操作重試"}`);
    else {
      const posted = data as Correction; setCorrection(posted); postKeyRef.current = null;
      window.localStorage.removeItem(`${STORAGE_PREFIX}:post-key`); window.localStorage.setItem(`${STORAGE_PREFIX}:id`, posted.id);
      setMessage("退回更正已 POST；有效退回量與人資倉庫存已在同一交易重算。");
    }
    setBusy(false);
  }
  function startAnother() {
    resetKeys(); window.localStorage.removeItem(`${STORAGE_PREFIX}:id`);
    setCorrection(null); setCorrectionNo(""); setDelta(0); setReason(""); setNote("");
    setMessage("可建立下一筆退回更正。");
  }

  if (!client) return <section className="panel import-panel" aria-label="退回更正"><div className="panel-heading"><div><p className="eyebrow">10 / RETURN CORRECTION</p><h2>退回更正</h2></div><span className="status-pill">預覽模式</span></div><p className="auth-message">登入 HR 帳號後，可針對已 POST 退回明細建立更正。</p></section>;
  const effectiveReturned = (selectedLine?.quantity ?? 0) + history.filter((row) => row.status === "POSTED").reduce((sum, row) => sum + row.delta, 0);
  return <section className="panel import-panel" aria-label="退回更正">
    <div className="panel-heading"><div><p className="eyebrow">10 / RETURN CORRECTION</p><h2>退回更正</h2></div><span className={`status-pill ${correction?.status === "POSTED" ? "success" : ""}`}>{correction?.status ?? "待建立"}</span></div>
    <p className="auth-message">更正不覆寫原退回單；POST 會鎖定原退回單與原發放明細，重算有效退回量，並以本次差額調整人資倉。</p>
    <div className="form-grid">
      <label className="field"><span>原始退回明細</span><select value={lineId} onChange={(event) => chooseLine(event.target.value)} disabled={busy || Boolean(correction)}><option value="">請選擇</option>{lines.map((line) => { const parent = returns.find((row) => row.id === line.return_note_id); return <option key={line.id} value={line.id}>{parent?.return_no}｜{line.employee_no_snapshot}｜{line.item_code_snapshot}｜原退回 {line.quantity}</option>; })}</select></label>
      <div className="metric"><span>目前有效退回量</span><strong>{selectedLine ? effectiveReturned : "—"}</strong><small>{selectedLine?.item_name_snapshot ?? "請先選擇明細"}</small></div>
      <label className="field"><span>更正單號</span><input value={correctionNo} onChange={(event) => { resetKeys(); setCorrectionNo(event.target.value); }} maxLength={80} disabled={busy || Boolean(correction)} placeholder="例如 RTC-RET-2026-001" /></label>
      <label className="field"><span>退回量差額</span><input type="number" step={1} value={delta} onChange={(event) => { resetKeys(); setDelta(Number(event.target.value) || 0); }} disabled={busy || Boolean(correction)} /></label>
    </div>
    <label className="field reason-field"><span>更正原因</span><input value={reason} onChange={(event) => { resetKeys(); setReason(event.target.value); }} maxLength={1000} disabled={busy || Boolean(correction)} placeholder="例如：退回數量誤登" /></label>
    <label className="field reason-field"><span>備註（選填）</span><input value={note} onChange={(event) => { resetKeys(); setNote(event.target.value); }} maxLength={2000} disabled={busy || Boolean(correction)} /></label>
    {validationError ? <p className="auth-message">{validationError}</p> : null}
    <CorrectionHistoryTable ariaLabel="退回更正歷史" rows={historyRows} deltaLabel="退回量差額" />
    <div className="button-row"><button className="primary-button" type="button" onClick={() => void createDraft()} disabled={busy || Boolean(correction) || !selectedLine}>{busy ? "建立中…" : "建立退回更正草稿"}</button>{correction?.status === "DRAFT" ? <button className="secondary-button" type="button" onClick={() => void postCorrection()} disabled={busy}>{busy ? "POST 中…" : "確認並 POST 更正"}</button> : null}{correction ? <button className="secondary-button" type="button" onClick={startAnother} disabled={busy}>建立另一筆更正</button> : null}</div>
    {correction ? <p className="success-note">更正單 {correction.correction_no}／狀態 {correction.status}。{correction.status === "DRAFT" ? "請確認數量與理由後 POST。" : "更正已鎖定。"}</p> : null}
    {message ? <p className={message.includes("已") ? "success-note" : "auth-message"} role="status">{message}</p> : null}
  </section>;
}
