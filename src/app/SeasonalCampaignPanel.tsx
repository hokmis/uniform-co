"use client";

import { useEffect, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "@/src/lib/supabase-browser";

type Employee = { id: string; employee_no: string; name: string };
type Item = { id: string; item_code: string; item_name: string; size: string | null };

function asIso(value: string) { return new Date(`${value}:00+08:00`).toISOString(); }
function taipeiDate() { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date()); }

export default function SeasonalCampaignPanel() {
  const client = getSupabaseBrowserClient();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [employeeIds, setEmployeeIds] = useState<string[]>([]);
  const [itemIds, setItemIds] = useState<string[]>([]);
  const [campaignNo, setCampaignNo] = useState("");
  const [name, setName] = useState("");
  const [season, setSeason] = useState("2026 秋冬");
  const [windowStart, setWindowStart] = useState(() => taipeiDate());
  const [windowEnd, setWindowEnd] = useState("2026-08-19");
  const [opensAt, setOpensAt] = useState("2026-08-12T09:00");
  const [closesAt, setClosesAt] = useState("2026-08-19T18:00");
  const [campaignId, setCampaignId] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [scopeReady, setScopeReady] = useState(false);
  const operationRef = useRef<{ createKey: string; scopeKey: string; openKey: string; campaignId?: string } | null>(null);

  function resetScopeKey() {
    if (operationRef.current) operationRef.current = { ...operationRef.current, scopeKey: crypto.randomUUID() };
    setScopeReady(false);
  }

  useEffect(() => {
    if (!client) return;
    const supabase = client;
    let active = true;
    async function load() {
      const [employeeResult, itemResult] = await Promise.all([
        supabase.from("employees").select("id,employee_no,name").eq("employment_status", "ACTIVE").order("employee_no"),
        supabase.from("uniform_items").select("id,item_code,item_name,size").eq("is_active", true).order("item_code"),
      ]);
      if (!active || employeeResult.error || itemResult.error) { setStatus("正式活動主檔載入失敗，請確認 HR 權限。 "); return; }
      const loadedEmployees = (employeeResult.data ?? []) as Employee[];
      const loadedItems = (itemResult.data ?? []) as Item[];
      setEmployees(loadedEmployees); setItems(loadedItems);
      setEmployeeIds(loadedEmployees.map((employee) => employee.id));
      setItemIds(loadedItems.map((item) => item.id));
    }
    void load();
    return () => { active = false; };
  }, [client]);

  async function createCampaign() {
    if (!client) { setStatus("預覽模式：設定 Supabase env 並登入 HR 後才能建立換季活動。"); return; }
    if (!campaignNo.trim() || !name.trim() || employeeIds.length === 0 || itemIds.length === 0) { setStatus("請填活動欄位，並至少選一位員工與一個品號。"); return; }
    setBusy(true); setStatus("");
    const operation = operationRef.current ?? { createKey: crypto.randomUUID(), scopeKey: crypto.randomUUID(), openKey: crypto.randomUUID() };
    operationRef.current = operation;
    const fingerprint = JSON.stringify({ campaignNo, name, season, windowStart, windowEnd, opensAt, closesAt, employeeIds, itemIds });
    let id = operation.campaignId;
    let campaignResult: { data: { id?: string; campaign_no?: string } | null; error: { message: string } | null } = { data: null, error: null };
    if (!id) campaignResult = await client.rpc("create_seasonal_campaign", {
      p_campaign_no: campaignNo.trim(), p_name: name.trim(), p_season: season.trim(), p_window_start: windowStart,
      p_window_end: windowEnd, p_opens_at: asIso(opensAt), p_closes_at: asIso(closesAt),
      p_idempotency_key: `CREATE-SEASONAL-${operation.createKey}`, p_request_fingerprint: fingerprint,
    });
    if (!id) id = campaignResult.data?.id as string | undefined;
    if (campaignResult.error || !id) { setStatus(campaignResult.error?.message ?? "活動建立失敗"); setBusy(false); return; }
    operation.campaignId = id;
    const scopeResult = await client.rpc("set_seasonal_campaign_scope", {
      p_campaign_id: id, p_employee_ids: employeeIds, p_item_ids: itemIds,
      p_idempotency_key: `SCOPE-SEASONAL-${operation.scopeKey}`, p_request_fingerprint: fingerprint,
    });
    if (scopeResult.error) { setCampaignId(id); setStatus(`活動已建立，但範圍設定失敗：${scopeResult.error.message}；可修正範圍後重試。`); setBusy(false); return; }
    setCampaignId(id);
    setScopeReady(true);
    setStatus(`活動 ${campaignResult.data?.campaign_no ?? ""} 已建立並完成員工/品號範圍設定；目前仍是 DRAFT。`);
    setBusy(false);
  }

  async function openCampaign() {
    if (!client || !campaignId) return;
    setBusy(true); setStatus("");
    const operation = operationRef.current ?? { createKey: crypto.randomUUID(), scopeKey: crypto.randomUUID(), openKey: crypto.randomUUID(), campaignId };
    operationRef.current = operation;
    const { data, error } = await client.rpc("open_seasonal_campaign", {
      p_campaign_id: campaignId, p_idempotency_key: `OPEN-SEASONAL-${operation.openKey}`,
      p_request_fingerprint: JSON.stringify({ campaignId }),
    });
    setStatus(error ? `尚未開放：${error.message}` : `換季需求窗口已開放（${data?.status ?? "OPEN"}），各窗口可依範圍填寫需求。`);
    setBusy(false);
  }

  if (!client) return <section className="panel import-panel" aria-label="換季需求活動"><div className="panel-heading"><div><p className="eyebrow">08 / SEASONAL</p><h2>換季需求活動</h2></div><span className="status-pill">預覽模式</span></div><p className="auth-message">設定 Supabase env 並登入 HR 後，可建立換季活動、凍結員工/品號範圍，再開放窗口填寫需求。</p></section>;

  return <section className="panel import-panel" aria-label="換季需求活動">
    <div className="panel-heading"><div><p className="eyebrow">08 / SEASONAL</p><h2>換季需求活動</h2></div><span className={`status-pill ${campaignId ? "success" : ""}`}>{campaignId ? "已建活動" : "設定中"}</span></div>
    <p className="auth-message">先建立並凍結本次活動的員工、品號範圍，再由 HR 依窗口時間開放填寫；送核仍由 CEO 核准 RPC 處理。</p>
    <div className="form-grid">
      <label className="field"><span>活動編號</span><input value={campaignNo} onChange={(event) => setCampaignNo(event.target.value)} disabled={busy || Boolean(campaignId)} placeholder="SEASON-2026-AW" /></label>
      <label className="field"><span>活動名稱</span><input value={name} onChange={(event) => setName(event.target.value)} disabled={busy || Boolean(campaignId)} placeholder="2026 秋冬制服需求" /></label>
      <label className="field"><span>季別</span><input value={season} onChange={(event) => setSeason(event.target.value)} disabled={busy || Boolean(campaignId)} /></label>
      <label className="field"><span>需求起日</span><input type="date" value={windowStart} onChange={(event) => setWindowStart(event.target.value)} disabled={busy || Boolean(campaignId)} /></label>
      <label className="field"><span>需求迄日</span><input type="date" value={windowEnd} onChange={(event) => setWindowEnd(event.target.value)} disabled={busy || Boolean(campaignId)} /></label>
      <label className="field"><span>開放時間</span><input type="datetime-local" value={opensAt} onChange={(event) => setOpensAt(event.target.value)} disabled={busy || Boolean(campaignId)} /></label>
      <label className="field"><span>截止時間</span><input type="datetime-local" value={closesAt} onChange={(event) => setClosesAt(event.target.value)} disabled={busy || Boolean(campaignId)} /></label>
    </div>
    <div className="form-grid">
      <label className="field"><span>活動員工範圍（可複選）</span><select multiple size={7} value={employeeIds} onChange={(event) => { resetScopeKey(); setEmployeeIds(Array.from(event.target.selectedOptions, (option) => option.value)); }} disabled={busy || scopeReady}>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.employee_no}｜{employee.name}</option>)}</select></label>
      <label className="field"><span>活動品號範圍（可複選）</span><select multiple size={7} value={itemIds} onChange={(event) => { resetScopeKey(); setItemIds(Array.from(event.target.selectedOptions, (option) => option.value)); }} disabled={busy || scopeReady}>{items.map((item) => <option key={item.id} value={item.id}>{item.item_code}｜{item.item_name}{item.size ? `｜${item.size}` : ""}</option>)}</select></label>
    </div>
    <div className="button-row"><button className="primary-button" type="button" onClick={() => void createCampaign()} disabled={busy || scopeReady}>{busy ? "處理中…" : campaignId ? "重試設定範圍" : "建立並凍結範圍"}</button><button className="secondary-button" type="button" onClick={() => void openCampaign()} disabled={busy || !scopeReady}>開放需求窗口</button></div>
    {status ? <p className={status.includes("已") || status.includes("開放") ? "success-note" : "auth-message"} role="status">{status}</p> : null}
  </section>;
}
