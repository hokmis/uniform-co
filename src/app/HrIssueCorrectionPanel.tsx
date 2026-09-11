"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import CorrectionHistoryTable from "@/src/app/CorrectionHistoryTable";
import { getSupabaseBrowserClient } from "@/src/lib/supabase-browser";
import { validateHrIssueCorrectionInput } from "@/src/domain/hr-issue-correction";
import type { CorrectionHistoryRow } from "@/src/domain/correction-history";

type Request = { id: string; request_no: string; status: "SHIPPED" | string; distribution_date: string };
type IssueLine = { id: string; request_id: string; line_no: number; employee_no_snapshot: string | null; employee_name_snapshot: string | null; item_code_snapshot: string | null; item_name_snapshot: string | null; quantity: number };
type Correction = { id: string; correction_no: string; status: "DRAFT" | "POSTED"; original_hr_request_id: string };
type History = { id: string; correction_no: string; status: string; reason: string; issue_quantity_delta: number; posted_at: string | null };

const STORAGE_PREFIX = "uniform:hr-issue-correction";

export default function HrIssueCorrectionPanel() {
  const client = getSupabaseBrowserClient();
  const [requests, setRequests] = useState<Request[]>([]);
  const [lines, setLines] = useState<IssueLine[]>([]);
  const [lineId, setLineId] = useState("");
  const [correctionNo, setCorrectionNo] = useState("");
  const [reason, setReason] = useState("");
  const [delta, setDelta] = useState(0);
  const [correction, setCorrection] = useState<Correction | null>(null);
  const [history, setHistory] = useState<History[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const createKeyRef = useRef<string | null>(null);
  const postKeyRef = useRef<string | null>(null);
  const recoveredLineIdRef = useRef<string | null>(null);
  const selectedLine = useMemo(() => lines.find((line) => line.id === lineId), [lines, lineId]);
  const selectedRequest = useMemo(() => requests.find((request) => request.id === selectedLine?.request_id), [requests, selectedLine]);
  const validationError = validateHrIssueCorrectionInput({ issueQuantityDelta: delta, reason });
  const historyRows: CorrectionHistoryRow[] = useMemo(() => history.map((item) => ({
    id: item.id,
    correctionNo: item.correction_no,
    status: item.status,
    reason: item.reason,
    deltaText: String(item.issue_quantity_delta),
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
      const { data, error } = await supabase.rpc("get_hr_issue_correction_status", {
        p_correction_note_id: savedCorrectionId,
        p_create_idempotency_key: savedCreateKey ? `HR-ISSUE-CORRECTION-DRAFT-${savedCreateKey}` : null,
        p_post_idempotency_key: savedPostKey ? `POST-HR-ISSUE-CORRECTION-${savedPostKey}` : null,
      });
      if (!active) return;
      if (error) { setMessage("更正結果尚未確認；請稍後以相同操作重試。"); return; }
      if (data?.id) {
        const recovered = data as Correction;
        setCorrection(recovered);
        window.localStorage.setItem(`${STORAGE_PREFIX}:id`, recovered.id);
        const { data: line } = await supabase.from("issue_correction_lines")
          .select("original_issue_line_id").eq("correction_note_id", recovered.id).maybeSingle();
        if (line?.original_issue_line_id) {
          recoveredLineIdRef.current = line.original_issue_line_id as string;
          if (active) setLineId(line.original_issue_line_id as string);
        }
        setMessage("已恢復上一筆人資發放更正；請確認狀態後繼續。");
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
      const requestResult = await supabase.from("hr_requests")
        .select("id,request_no,status,distribution_date").eq("status", "SHIPPED").order("distribution_date", { ascending: false });
      if (!active) return;
      if (requestResult.error) { setMessage("已發放需求載入失敗，請確認 HR 角色與 RLS 權限。"); return; }
      const loadedRequests = (requestResult.data ?? []) as Request[];
      const requestIds = loadedRequests.map((request) => request.id);
      const lineResult = requestIds.length > 0
        ? await supabase.from("hr_issue_lines").select("id,request_id,line_no,employee_no_snapshot,employee_name_snapshot,item_code_snapshot,item_name_snapshot,quantity").in("request_id", requestIds).order("line_no")
        : { data: [], error: null };
      if (!active) return;
      if (lineResult.error) { setMessage("發放明細載入失敗，請重新整理。"); return; }
      const loadedLines = (lineResult.data ?? []) as IssueLine[];
      setRequests(loadedRequests); setLines(loadedLines);
      const recoveredLineId = recoveredLineIdRef.current;
      if (recoveredLineId && loadedLines.some((line) => line.id === recoveredLineId)) setLineId(recoveredLineId);
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
      const { data: notes, error } = await supabase.from("correction_notes")
        .select("id,correction_no,status,reason,posted_at")
        .eq("correction_kind", "HR_ISSUE").eq("original_hr_request_id", sourceLine.request_id).order("id", { ascending: false });
      if (!active || error) return;
      const noteRows = (notes ?? []) as Array<{ id: string; correction_no: string; status: string; reason: string; posted_at: string | null }>;
      const ids = noteRows.map((note) => note.id);
      if (ids.length === 0) { setHistory([]); return; }
      const { data: correctionLines } = await supabase.from("issue_correction_lines")
        .select("correction_note_id,original_issue_line_id,issue_quantity_delta").in("correction_note_id", ids);
      if (!active) return;
      const byNote = new Map((correctionLines ?? []).filter((line) => line.original_issue_line_id === sourceLine.id).map((line) => [line.correction_note_id as string, line]));
      setHistory(noteRows.filter((note) => byNote.has(note.id)).map((note) => {
        const line = byNote.get(note.id);
        return { id: note.id, correction_no: note.correction_no, status: note.status, reason: note.reason, issue_quantity_delta: Number(line?.issue_quantity_delta ?? 0), posted_at: note.posted_at };
      }));
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
    resetKeys(); window.localStorage.removeItem(`${STORAGE_PREFIX}:id`);
    setLineId(nextId); setCorrection(null); setCorrectionNo(""); setReason(""); setDelta(0);
  }
  async function createDraft() {
    if (!client || !selectedLine) { setMessage("請先選擇已 SHIPPED 的人資發放明細。"); return; }
    if (validationError || !correctionNo.trim()) { setMessage(validationError ?? "請填寫更正單號。"); return; }
    setBusy(true); setMessage("");
    const key = createKeyRef.current ?? crypto.randomUUID(); createKeyRef.current = key;
    window.localStorage.setItem(`${STORAGE_PREFIX}:create-key`, key);
    const fingerprint = JSON.stringify({ lineId: selectedLine.id, correctionNo: correctionNo.trim(), delta, reason: reason.trim() });
    const { data, error } = await client.rpc("create_hr_issue_correction_draft", {
      p_correction_no: correctionNo.trim(), p_original_issue_line_id: selectedLine.id,
      p_issue_quantity_delta: delta, p_reason: reason.trim(), p_note: null,
      p_idempotency_key: `HR-ISSUE-CORRECTION-DRAFT-${key}`, p_request_fingerprint: fingerprint,
    });
    if (error || !data?.id) setMessage(`人資發放更正結果尚未確認：${error?.message ?? "請使用相同操作重試"}`);
    else {
      const created = data as Correction; setCorrection(created);
      window.localStorage.removeItem(`${STORAGE_PREFIX}:create-key`); createKeyRef.current = null;
      window.localStorage.setItem(`${STORAGE_PREFIX}:id`, created.id); setMessage("人資發放更正草稿已建立；確認後再 POST。");
    }
    setBusy(false);
  }
  async function postDraft() {
    if (!client || !correction || correction.status !== "DRAFT") return;
    setBusy(true); setMessage("");
    const key = postKeyRef.current ?? crypto.randomUUID(); postKeyRef.current = key;
    window.localStorage.setItem(`${STORAGE_PREFIX}:post-key`, key);
    const { data, error } = await client.rpc("post_hr_issue_correction", {
      p_correction_note_id: correction.id, p_idempotency_key: `POST-HR-ISSUE-CORRECTION-${key}`,
      p_request_fingerprint: JSON.stringify({ correctionId: correction.id, correctionNo: correction.correction_no }),
    });
    if (error || !data?.id) setMessage(`人資發放更正 POST 結果尚未確認：${error?.message ?? "請使用相同操作重試"}`);
    else {
      setCorrection(data as Correction); window.localStorage.removeItem(`${STORAGE_PREFIX}:post-key`); postKeyRef.current = null;
      window.localStorage.setItem(`${STORAGE_PREFIX}:id`, correction.id); setMessage("人資發放更正已 POST；有效發放量、退回上限與人資倉餘額已在同一交易重算。");
    }
    setBusy(false);
  }
  function startAnother() {
    resetKeys(); window.localStorage.removeItem(`${STORAGE_PREFIX}:id`); setCorrection(null); setCorrectionNo(""); setReason(""); setDelta(0); setMessage("可建立下一筆人資發放更正。");
  }

  if (!client) return <section className="panel import-panel" aria-label="人資發放更正"><div className="panel-heading"><div><p className="eyebrow">16 / HR ISSUE CORRECTION</p><h2>人資發放更正</h2></div><span className="status-pill">預覽模式</span></div><p className="auth-message">登入 HR 帳號後，可選擇已發放明細建立具理由的更正單。</p></section>;
  const postedDelta = history.filter((item) => item.status === "POSTED").reduce((sum, item) => sum + item.issue_quantity_delta, 0);
  return <section className="panel import-panel" aria-label="人資發放更正">
    <div className="panel-heading"><div><p className="eyebrow">16 / HR ISSUE CORRECTION</p><h2>人資發放更正</h2></div><span className={`status-pill ${correction?.status === "POSTED" ? "success" : ""}`}>{correction?.status ?? "待建立"}</span></div>
    <p className="auth-message">更正只可指向已 SHIPPED 的原始發放明細；正數代表補登發放、負數代表沖回。受保護 RPC 會鎖定品號、需求與原明細，重算有效發放／退回上限及人資倉餘額。</p>
    <div className="form-grid">
      <label className="field"><span>原始發放明細</span><select value={lineId} onChange={(event) => chooseLine(event.target.value)} disabled={busy || Boolean(correction)}><option value="">請選擇</option>{lines.map((line) => { const request = requests.find((row) => row.id === line.request_id); return <option key={line.id} value={line.id}>{request?.request_no}｜{line.item_code_snapshot}｜{line.employee_no_snapshot ?? line.employee_name_snapshot}｜原發放 {line.quantity}</option>; })}</select></label>
      <div className="metric"><span>原始品號／人員</span><strong>{selectedLine?.item_code_snapshot ?? "—"}</strong><small>{selectedLine?.item_name_snapshot ?? selectedLine?.employee_name_snapshot ?? selectedRequest?.request_no ?? "請先選擇明細"}</small></div>
      <label className="field"><span>更正單號</span><input value={correctionNo} onChange={(event) => { resetKeys(); setCorrectionNo(event.target.value); }} maxLength={80} disabled={busy || Boolean(correction)} placeholder="例如 HIC-2026-001" /></label>
      <label className="field"><span>發放量差額</span><input type="number" step={1} value={delta} onChange={(event) => { resetKeys(); setDelta(Number(event.target.value) || 0); }} disabled={busy || Boolean(correction)} /></label>
    </div>
    {selectedLine ? <div className="metric"><span>目前有效發放量（原始 + 已 POST 更正）</span><strong>{selectedLine.quantity + postedDelta}</strong><small>{history.filter((item) => item.status === "POSTED").length > 0 ? `已有 ${history.filter((item) => item.status === "POSTED").length} 筆已 POST 更正` : "尚無已 POST 更正"}</small></div> : null}
    <CorrectionHistoryTable ariaLabel="人資發放更正歷史" rows={historyRows} deltaLabel="發放差額" />
    <label className="field reason-field"><span>更正原因</span><input value={reason} onChange={(event) => { resetKeys(); setReason(event.target.value); }} maxLength={500} disabled={busy || Boolean(correction)} placeholder="例如：補發一件制服" /></label>
    {validationError ? <p className="auth-message">{validationError}</p> : null}
    <div className="button-row"><button className="primary-button" type="button" onClick={() => void createDraft()} disabled={busy || Boolean(correction) || !selectedLine}>{busy ? "建立中…" : "建立更正草稿"}</button>{correction?.status === "DRAFT" ? <button className="secondary-button" type="button" onClick={() => void postDraft()} disabled={busy}>{busy ? "POST 中…" : "確認並 POST 更正"}</button> : null}{correction ? <button className="secondary-button" type="button" onClick={startAnother} disabled={busy}>建立另一筆更正</button> : null}</div>
    {correction ? <p className="success-note">更正單 {correction.correction_no}／狀態 {correction.status}。{correction.status === "DRAFT" ? "確認差額與理由後再 POST。" : "更正已鎖定，不能再次修改。"}</p> : null}
    {message ? <p className={message.includes("已") ? "success-note" : "auth-message"} role="status">{message}</p> : null}
  </section>;
}
