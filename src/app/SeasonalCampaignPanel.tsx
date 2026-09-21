"use client";

import { useEffect, useRef, useState } from "react";
import { staleReadSnapshotMessage } from "@/src/domain/read-refresh";
import { runSeasonalCampaignSetup } from "@/src/domain/seasonal-campaign";
import { invalidateMasterDataCache, loadActiveEmployeeOptions, loadActiveItemOptions } from "@/src/lib/master-data-cache";
import { isSupabaseSessionSyncError, safeSupabaseMutationErrorMessage } from "@/src/lib/supabase-session";
import { usePanelActivity } from "./RetainedPanelSet";
import { useWorkspaceSession } from "./workspace-session";

type Employee = { id: string; employee_no: string; name: string };
type Item = { id: string; item_code: string; item_name: string; size: string | null };

function asIso(value: string) { return new Date(`${value}:00+08:00`).toISOString(); }
function taipeiDate(offsetDays = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(date);
}

export default function SeasonalCampaignPanel() {
  const { client, isAuthenticated, accountId, identityError, identityLoading } = useWorkspaceSession();
  const panelActive = usePanelActivity();
  const hasSession = isAuthenticated;
  const identityReady = Boolean(client && panelActive && hasSession && accountId && !identityLoading && !identityError);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [employeeIds, setEmployeeIds] = useState<string[]>([]);
  const [itemIds, setItemIds] = useState<string[]>([]);
  const [campaignNo, setCampaignNo] = useState("");
  const [name, setName] = useState("");
  const [season, setSeason] = useState("2026 秋冬");
  const [windowStart, setWindowStart] = useState(() => taipeiDate());
  const [windowEnd, setWindowEnd] = useState(() => taipeiDate(7));
  const [opensAt, setOpensAt] = useState(() => `${taipeiDate()}T09:00`);
  const [closesAt, setClosesAt] = useState(() => `${taipeiDate(7)}T18:00`);
  const [campaignId, setCampaignId] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [dataLoading, setDataLoading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [scopeReady, setScopeReady] = useState(false);
  const [optionsSnapshotReady, setOptionsSnapshotReady] = useState(false);
  const [optionsSnapshotAccountId, setOptionsSnapshotAccountId] = useState<string | null>(null);
  const optionsLoadSequence = useRef(0);
  const optionsInitialized = useRef(false);
  const optionsSnapshotReadyRef = useRef(false);
  const operationRef = useRef<{ createKey: string; scopeKey: string; openKey: string; campaignId?: string } | null>(null);
  const displayStatus = identityError ?? status;
  const hasCurrentOptionsSnapshot = Boolean(
    identityReady
      && optionsSnapshotReady
      && optionsSnapshotAccountId
      && optionsSnapshotAccountId === accountId,
  );
  const optionsReadBlocked = !hasCurrentOptionsSnapshot;
  const visibleEmployees = hasCurrentOptionsSnapshot ? employees : [];
  const visibleItems = hasCurrentOptionsSnapshot ? items : [];

  function resetScopeKey() {
    if (operationRef.current) operationRef.current = { ...operationRef.current, scopeKey: crypto.randomUUID() };
    setScopeReady(false);
  }

  useEffect(() => {
    if (!identityReady || !client) {
      return;
    }
    const supabase = client;
    const sequence = optionsLoadSequence.current + 1;
    optionsLoadSequence.current = sequence;
    let active = true;
    async function load() {
      setDataLoading(true);
      try {
        setStatus("正在重新確認活動可用範圍…");
        const [employeeResult, itemResult] = await Promise.all([
          loadActiveEmployeeOptions(supabase),
          loadActiveItemOptions(supabase),
        ]);
        if (!active || sequence !== optionsLoadSequence.current) return;
        const readErrors = [...employeeResult.errors, ...itemResult.errors];
        if (readErrors.length > 0) {
          const preserveSnapshot = optionsSnapshotReadyRef.current
            && readErrors.every((error) => isSupabaseSessionSyncError(error));
          if (!preserveSnapshot) {
            optionsSnapshotReadyRef.current = false;
            setOptionsSnapshotReady(false);
            setOptionsSnapshotAccountId(null);
            setEmployees([]);
            setItems([]);
            setEmployeeIds([]);
            setItemIds([]);
            optionsInitialized.current = false;
          }
          setStatus(preserveSnapshot
            ? staleReadSnapshotMessage("換季活動選項")
            : "正式活動主檔載入失敗，請確認 HR 權限。 ");
          return;
        }
        const loadedEmployees = employeeResult.employees.map((employee) => ({ id: employee.id, employee_no: employee.employee_no, name: employee.name }));
        const loadedItems = itemResult.items as Item[];
        setEmployees(loadedEmployees); setItems(loadedItems);
        optionsSnapshotReadyRef.current = true;
        setOptionsSnapshotReady(true);
        setOptionsSnapshotAccountId(accountId);
        const employeeIdsSet = new Set(loadedEmployees.map((employee) => employee.id));
        const itemIdsSet = new Set(loadedItems.map((item) => item.id));
        setEmployeeIds((current) => optionsInitialized.current ? current.filter((id) => employeeIdsSet.has(id)) : loadedEmployees.map((employee) => employee.id));
        setItemIds((current) => optionsInitialized.current ? current.filter((id) => itemIdsSet.has(id)) : loadedItems.map((item) => item.id));
        optionsInitialized.current = true;
        setStatus(`已載入 ${loadedEmployees.length} 位在職員工、${loadedItems.length} 個啟用品號`);
      } finally {
        if (active && sequence === optionsLoadSequence.current) setDataLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, [accountId, client, identityError, identityReady, panelActive, reloadToken]);

  function reloadCampaignOptions() {
    if (client) {
      invalidateMasterDataCache(client, "active-employees");
      invalidateMasterDataCache(client, "active-items");
    }
    setStatus("正在重新載入活動選項…");
    setReloadToken((current) => current + 1);
  }

  async function createCampaign() {
    if (!identityReady || !client) { setStatus(identityError ?? "正在確認工作區身份，確認完成後才能建立換季活動。"); return; }
    if (optionsReadBlocked) { setStatus("活動員工／品號選項尚未完成載入，請稍候或重新載入後再建立活動。"); return; }
    if (!campaignNo.trim() || !name.trim() || employeeIds.length === 0 || itemIds.length === 0) { setStatus("請填活動欄位，並至少選一位員工與一個品號。"); return; }
    if (!windowStart || !windowEnd || windowEnd < windowStart || !opensAt || !closesAt || new Date(`${closesAt}:00+08:00`) <= new Date(`${opensAt}:00+08:00`)) {
      setStatus("請確認需求日期區間與開放／截止時間，截止時間必須晚於開放時間。");
      return;
    }
    setBusy(true); setStatus("");
    const operation = operationRef.current ?? { createKey: crypto.randomUUID(), scopeKey: crypto.randomUUID(), openKey: crypto.randomUUID() };
    operationRef.current = operation;
    const setup = await runSeasonalCampaignSetup(
      async (functionName, args) => {
        const { data, error } = await client.rpc(functionName, args);
        return { data, error };
      },
      {
        campaignNo: campaignNo.trim(),
        name: name.trim(),
        season: season.trim(),
        windowStart,
        windowEnd,
        opensAt: asIso(opensAt),
        closesAt: asIso(closesAt),
        employeeIds,
        itemIds,
        createIdempotencyKey: `CREATE-SEASONAL-${operation.createKey}`,
        createRequestFingerprint: JSON.stringify({ campaignNo: campaignNo.trim(), name: name.trim(), season: season.trim(), windowStart, windowEnd, opensAt, closesAt }),
        scopeIdempotencyKey: `SCOPE-SEASONAL-${operation.scopeKey}`,
        scopeRequestFingerprint: JSON.stringify({ campaignNo: campaignNo.trim(), employeeIds, itemIds }),
        existingCampaignId: operation.campaignId,
      },
      client,
    );
    const campaign = setup.campaign;
    if (setup.failureStage || setup.error || !campaign) {
      if (setup.failureStage === "scope" && campaign) {
        operation.campaignId = campaign.id;
        setCampaignId(campaign.id);
        setStatus(`活動已建立，但範圍設定失敗：${safeSupabaseMutationErrorMessage(setup.error, "可修正範圍後重試。")}`);
      } else {
        setStatus(safeSupabaseMutationErrorMessage(setup.error, "活動建立或範圍設定失敗；請使用相同設定重試。"));
      }
      setBusy(false);
      return;
    }
    operation.campaignId = campaign.id;
    setCampaignId(campaign.id);
    setScopeReady(true);
    setStatus(`活動 ${campaign.campaign_no ?? campaignNo.trim()} 已建立並完成員工／品號範圍設定；目前為草稿。`);
    setBusy(false);
  }

  async function openCampaign() {
    if (!identityReady || !client || !campaignId) return;
    setBusy(true); setStatus("");
    const operation = operationRef.current ?? { createKey: crypto.randomUUID(), scopeKey: crypto.randomUUID(), openKey: crypto.randomUUID(), campaignId };
    operationRef.current = operation;
    const { error } = await client.rpc("open_seasonal_campaign", {
      p_campaign_id: campaignId, p_idempotency_key: `OPEN-SEASONAL-${operation.openKey}`,
      p_request_fingerprint: JSON.stringify({ campaignId }),
    });
    setStatus(error ? safeSupabaseMutationErrorMessage(error, "活動尚未開放；請使用相同設定重試。") : "換季需求窗口已開放，各窗口可依範圍填寫需求。");
    setBusy(false);
  }

  if (!client) return <section className="panel import-panel" aria-label="換季需求活動"><div className="panel-heading"><div><p className="eyebrow">08 / SEASONAL</p><h2>換季需求活動</h2></div><span className="status-pill">預覽模式</span></div><p className="auth-message">設定 Supabase env 並登入 HR 後，可建立換季活動、凍結員工/品號範圍，再開放窗口填寫需求。</p></section>;

  return <section className="panel import-panel" aria-label="換季需求活動" aria-busy={dataLoading}>
    <div className="panel-heading"><div><p className="eyebrow">08 / SEASONAL</p><h2>換季需求活動</h2></div><div className="heading-actions"><span className={`status-pill ${campaignId ? "success" : ""}`}>{campaignId ? "已建活動" : "設定中"}</span><button className="secondary-button" type="button" onClick={reloadCampaignOptions} disabled={busy}>{dataLoading ? "載入選項中…" : busy ? "處理中…" : "重新載入選項"}</button></div></div>
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
      <label className="field"><span>活動員工範圍（可複選）</span><select multiple size={7} value={employeeIds} onChange={(event) => { resetScopeKey(); setEmployeeIds(Array.from(event.target.selectedOptions, (option) => option.value)); }} disabled={busy || optionsReadBlocked || scopeReady}>{visibleEmployees.map((employee) => <option key={employee.id} value={employee.id}>{employee.employee_no}｜{employee.name}</option>)}</select></label>
      <label className="field"><span>活動品號範圍（可複選）</span><select multiple size={7} value={itemIds} onChange={(event) => { resetScopeKey(); setItemIds(Array.from(event.target.selectedOptions, (option) => option.value)); }} disabled={busy || optionsReadBlocked || scopeReady}>{visibleItems.map((item) => <option key={item.id} value={item.id}>{item.item_code}｜{item.item_name}{item.size ? `｜${item.size}` : ""}</option>)}</select></label>
    </div>
    <div className="button-row"><button className="primary-button" type="button" onClick={() => void createCampaign()} disabled={busy || optionsReadBlocked || !identityReady || scopeReady}>{busy ? "處理中…" : optionsReadBlocked ? "等待活動選項…" : campaignId ? "重試設定範圍" : "建立並凍結範圍"}</button><button className="secondary-button" type="button" onClick={() => void openCampaign()} disabled={busy || !identityReady || !scopeReady}>開放需求窗口</button></div>
    {displayStatus ? <p className={displayStatus.includes("已") || displayStatus.includes("開放") ? "success-note" : "auth-message"} role="status">{displayStatus}</p> : null}
  </section>;
}
