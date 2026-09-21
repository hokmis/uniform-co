"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ManagementCatalogTable, { type ManagementCatalogColumn } from "@/src/app/ManagementCatalogTable";
import { filterSeasonalDemandQueue, sortSeasonalDemandQueue, type SeasonalDemandQueueRow, type SeasonalDemandSortDirection, type SeasonalDemandSortKey } from "@/src/domain/seasonal-demand";
import { staleReadSnapshotMessage } from "@/src/domain/read-refresh";
import { isSupabaseSessionSyncError, retrySupabaseQueriesAfterSessionRefresh, safeSupabaseMutationErrorMessage } from "@/src/lib/supabase-session";
import { useWorkspaceSession } from "./workspace-session";
import { usePanelActivity } from "./RetainedPanelSet";

type Campaign = { id: string; campaign_no: string; name: string; closes_at: string };
type Employee = { employee_id: string; employee_no_snapshot: string; employee_name_snapshot: string };
type Item = { item_id: string; item_code_snapshot: string; item_name_snapshot: string; size_snapshot: string | null; unit_snapshot: string };
type DemandLine = { id: string; employee_id: string; item_id: string; employee_no_snapshot: string | null; employee_name_snapshot: string | null; item_code_snapshot: string | null; item_name_snapshot: string | null; size_snapshot: string | null; quantity: number; hr_modified: boolean; hr_note: string | null; updated_at: string };

export default function SeasonalDemandPanel() {
  const { client, accountId, identityError, identityLoading, isAuthenticated } = useWorkspaceSession();
  const panelActive = usePanelActivity();
  const identityReady = Boolean(client && panelActive && isAuthenticated && accountId && !identityLoading && !identityError);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [demandLines, setDemandLines] = useState<DemandLine[]>([]);
  const [campaignId, setCampaignId] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [itemId, setItemId] = useState("");
  const [demandLineId, setDemandLineId] = useState("");
  const [quantity, setQuantity] = useState(0);
  const [note, setNote] = useState("");
  const [queueQuery, setQueueQuery] = useState("");
  const [queuePage, setQueuePage] = useState(1);
  const [queueSortKey, setQueueSortKey] = useState<SeasonalDemandSortKey>("employee_no");
  const [queueSortDirection, setQueueSortDirection] = useState<SeasonalDemandSortDirection>("asc");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [campaignLoading, setCampaignLoading] = useState(false);
  const [scopeLoading, setScopeLoading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const operationKeyRef = useRef<string | null>(null);
  const scopeLoadSequence = useRef(0);
  const [campaignSnapshotReady, setCampaignSnapshotReady] = useState(false);
  const [campaignSnapshotAccountId, setCampaignSnapshotAccountId] = useState<string | null>(null);
  const [scopeSnapshotReady, setScopeSnapshotReady] = useState(false);
  const [scopeSnapshotKey, setScopeSnapshotKey] = useState<string | null>(null);
  const campaignSnapshotReadyRef = useRef(false);
  const scopeSnapshotReadyRef = useRef(false);
  const scopeSnapshotKeyRef = useRef<string | null>(null);

  function resetOperation() { operationKeyRef.current = null; }

  const activeCampaign = campaigns.find((campaign) => campaign.id === campaignId);
  const currentScopeKey = accountId && campaignId ? `${accountId}:${campaignId}` : null;
  const hasCurrentCampaignSnapshot = Boolean(
    identityReady
      && campaignSnapshotReady
      && campaignSnapshotAccountId
      && campaignSnapshotAccountId === accountId,
  );
  const hasCurrentScopeSnapshot = Boolean(
    hasCurrentCampaignSnapshot
      && activeCampaign
      && scopeSnapshotReady
      && scopeSnapshotKey
      && scopeSnapshotKey === currentScopeKey,
  );
  const campaignReadBlocked = !hasCurrentCampaignSnapshot;
  const scopeReadBlocked = !hasCurrentScopeSnapshot;
  const visibleEmployees = hasCurrentScopeSnapshot ? employees : [];
  const visibleItems = hasCurrentScopeSnapshot ? items : [];
  const visibleDemandLines = useMemo(() => hasCurrentScopeSnapshot ? demandLines : [], [demandLines, hasCurrentScopeSnapshot]);
  const queueRows: SeasonalDemandQueueRow[] = useMemo(() => visibleDemandLines.map((line) => ({
    id: line.id,
    employeeNo: line.employee_no_snapshot ?? line.employee_id,
    employeeName: line.employee_name_snapshot ?? "員工",
    itemCode: line.item_code_snapshot ?? line.item_id,
    itemName: line.item_name_snapshot ?? "制服品號",
    size: line.size_snapshot,
    quantity: line.quantity,
    updatedAt: line.updated_at,
    hrModified: line.hr_modified,
  })), [visibleDemandLines]);
  const filteredQueueRows = useMemo(() => filterSeasonalDemandQueue(queueRows, queueQuery), [queueQuery, queueRows]);
  const sortedQueueRows = useMemo(() => sortSeasonalDemandQueue(filteredQueueRows, queueSortKey, queueSortDirection), [filteredQueueRows, queueSortDirection, queueSortKey]);
  const dataLoading = campaignLoading || scopeLoading;

  function chooseCampaign(nextCampaignId: string) {
    resetOperation();
    scopeLoadSequence.current += 1;
    scopeSnapshotReadyRef.current = false;
    scopeSnapshotKeyRef.current = null;
    setScopeSnapshotReady(false);
    setScopeSnapshotKey(null);
    setScopeLoading(false);
    setCampaignId(nextCampaignId);
    setEmployeeId("");
    setItemId("");
    setDemandLineId("");
    setQuantity(0);
    setNote("");
    setDemandLines([]);
    setMessage("");
    setQueuePage(1);
  }

  function changeEmployee(nextEmployeeId: string) {
    resetOperation();
    setDemandLineId("");
    setEmployeeId(nextEmployeeId);
    setQuantity(0);
    setNote("");
  }

  function changeItem(nextItemId: string) {
    resetOperation();
    setDemandLineId("");
    setItemId(nextItemId);
    setQuantity(0);
    setNote("");
  }

  function selectDemandLine(nextId: string) {
    const line = demandLines.find((row) => row.id === nextId);
    if (!line) return;
    resetOperation();
    setDemandLineId(line.id);
    setEmployeeId(line.employee_id);
    setItemId(line.item_id);
    setQuantity(line.quantity);
    setNote(line.hr_note ?? "");
    setMessage("");
    setQueuePage(1);
  }

  function startNewDemand() {
    resetOperation();
    setDemandLineId("");
    setQuantity(0);
    setNote("");
    setMessage("");
  }

  function sortQueue(nextKey: SeasonalDemandSortKey) {
    if (queueSortKey === nextKey) setQueueSortDirection((current) => current === "asc" ? "desc" : "asc");
    else { setQueueSortKey(nextKey); setQueueSortDirection("asc"); }
    setQueuePage(1);
  }

  useEffect(() => {
    if (!identityReady || !client) return;
    const supabase = client;
    let active = true;
    async function load() {
      setCampaignLoading(true);
      try {
        setMessage("正在讀取開放中的換季活動…");
        const [campaignResult] = await retrySupabaseQueriesAfterSessionRefresh(
          supabase,
          async () => [await supabase.from("seasonal_campaigns").select("id,campaign_no,name,closes_at").eq("status", "OPEN").order("closes_at")] as const,
        );
        if (!active) return;
        if (campaignResult.error) {
          const preserveSnapshot = campaignSnapshotReadyRef.current && isSupabaseSessionSyncError(campaignResult.error);
          if (!preserveSnapshot) {
            campaignSnapshotReadyRef.current = false;
            setCampaignSnapshotReady(false);
            setCampaignSnapshotAccountId(null);
            setCampaigns([]);
            scopeLoadSequence.current += 1;
            scopeSnapshotReadyRef.current = false;
            scopeSnapshotKeyRef.current = null;
            setScopeSnapshotReady(false);
            setScopeSnapshotKey(null);
            setCampaignId("");
            setEmployeeId("");
            setItemId("");
            setDemandLineId("");
            setEmployees([]);
            setItems([]);
            setDemandLines([]);
            setQuantity(0);
            setNote("");
            operationKeyRef.current = null;
          }
          setMessage(preserveSnapshot
            ? staleReadSnapshotMessage("開放中的換季活動")
            : "無法載入開放中的換季活動，請確認窗口帳號與資料權限。");
          return;
        }
        const loadedCampaigns = (campaignResult.data ?? []) as Campaign[];
        setCampaigns(loadedCampaigns);
        campaignSnapshotReadyRef.current = true;
        setCampaignSnapshotReady(true);
        setCampaignSnapshotAccountId(accountId);
        setCampaignId((current) => loadedCampaigns.some((campaign) => campaign.id === current) ? current : "");
        if (loadedCampaigns.length === 0) setMessage("目前沒有開放中的換季活動。");
      } finally {
        if (active) setCampaignLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, [accountId, client, identityReady, reloadToken]);

  const selectedCampaignAvailable = Boolean(campaignId && campaigns.some((campaign) => campaign.id === campaignId));

  useEffect(() => {
    if (!identityReady || !client || !campaignId || !selectedCampaignAvailable) return;
    const supabase = client;
    const sequence = scopeLoadSequence.current + 1;
    scopeLoadSequence.current = sequence;
    let active = true;
    async function loadScope() {
      setScopeLoading(true);
      try {
        setMessage("正在讀取活動範圍與既有需求…");
        const [workspaceResult] = await retrySupabaseQueriesAfterSessionRefresh(
          supabase,
          async () => [await supabase.from("v_seasonal_demand_workspace").select("scope_kind,campaign_id,employee_id,employee_no_snapshot,employee_name_snapshot,item_id,item_code_snapshot,item_name_snapshot,size_snapshot,unit_snapshot,demand_line_id,demand_employee_no_snapshot,demand_employee_name_snapshot,demand_item_code_snapshot,demand_item_name_snapshot,demand_size_snapshot,demand_quantity,demand_hr_modified,demand_hr_note,demand_updated_at").eq("campaign_id", campaignId).order("scope_kind")] as const,
        );
        if (!active) return;
        if (workspaceResult.error) {
          const preserveSnapshot = scopeSnapshotReadyRef.current
            && scopeSnapshotKeyRef.current === currentScopeKey
            && isSupabaseSessionSyncError(workspaceResult.error);
          if (!preserveSnapshot) {
            scopeSnapshotReadyRef.current = false;
            scopeSnapshotKeyRef.current = null;
            setScopeSnapshotReady(false);
            setScopeSnapshotKey(null);
            setEmployees([]);
            setItems([]);
            setDemandLines([]);
            setDemandLineId("");
            setEmployeeId("");
            setItemId("");
            setQuantity(0);
            setNote("");
          }
          setMessage(preserveSnapshot
            ? staleReadSnapshotMessage("活動範圍與既有需求")
            : "活動範圍或既有需求載入失敗，請確認窗口是否在授權機構/部門。");
          return;
        }
        const workspaceRows = (workspaceResult.data ?? []) as Array<{
        scope_kind: "EMPLOYEE" | "ITEM" | "DEMAND";
        campaign_id: string;
        employee_id: string | null;
        employee_no_snapshot: string | null;
        employee_name_snapshot: string | null;
        item_id: string | null;
        item_code_snapshot: string | null;
        item_name_snapshot: string | null;
        size_snapshot: string | null;
        unit_snapshot: string | null;
        demand_line_id: string | null;
        demand_employee_no_snapshot: string | null;
        demand_employee_name_snapshot: string | null;
        demand_item_code_snapshot: string | null;
        demand_item_name_snapshot: string | null;
        demand_size_snapshot: string | null;
        demand_quantity: number | null;
        demand_hr_modified: boolean | null;
        demand_hr_note: string | null;
        demand_updated_at: string | null;
      }>;
        const employeeRows = workspaceRows
        .filter((row) => row.scope_kind === "EMPLOYEE" && row.employee_id && row.employee_no_snapshot && row.employee_name_snapshot)
        .map((row) => ({ employee_id: row.employee_id as string, employee_no_snapshot: row.employee_no_snapshot as string, employee_name_snapshot: row.employee_name_snapshot as string } satisfies Employee));
        const itemRows = workspaceRows
        .filter((row) => row.scope_kind === "ITEM" && row.item_id && row.item_code_snapshot && row.item_name_snapshot && row.unit_snapshot)
        .map((row) => ({ item_id: row.item_id as string, item_code_snapshot: row.item_code_snapshot as string, item_name_snapshot: row.item_name_snapshot as string, size_snapshot: row.size_snapshot, unit_snapshot: row.unit_snapshot as string } satisfies Item));
        const loadedDemandLines = workspaceRows
        .filter((row) => row.scope_kind === "DEMAND" && row.demand_line_id && row.employee_id && row.item_id && row.demand_updated_at)
        .map((row) => ({
          id: row.demand_line_id as string,
          employee_id: row.employee_id as string,
          item_id: row.item_id as string,
          employee_no_snapshot: row.demand_employee_no_snapshot,
          employee_name_snapshot: row.demand_employee_name_snapshot,
          item_code_snapshot: row.demand_item_code_snapshot,
          item_name_snapshot: row.demand_item_name_snapshot,
          size_snapshot: row.demand_size_snapshot,
          quantity: Number(row.demand_quantity ?? 0),
          hr_modified: Boolean(row.demand_hr_modified),
          hr_note: row.demand_hr_note,
          updated_at: row.demand_updated_at as string,
        } satisfies DemandLine));
        setEmployees(employeeRows); setItems(itemRows);
        setDemandLines(loadedDemandLines);
        scopeSnapshotReadyRef.current = true;
        scopeSnapshotKeyRef.current = currentScopeKey;
        setScopeSnapshotReady(true);
        setScopeSnapshotKey(currentScopeKey);
        setDemandLineId((current) => loadedDemandLines.some((row) => row.id === current) ? current : "");
        setEmployeeId((current) => employeeRows.some((row) => row.employee_id === current) ? current : "");
        setItemId((current) => itemRows.some((row) => row.item_id === current) ? current : "");
        setMessage(`已載入 ${employeeRows.length} 位授權員工、${itemRows.length} 個品號與 ${loadedDemandLines.length} 筆需求`);
      } finally {
        if (active && sequence === scopeLoadSequence.current) setScopeLoading(false);
      }
    }
    void loadScope();
    return () => { active = false; };
  }, [campaignId, client, currentScopeKey, identityReady, reloadToken, selectedCampaignAvailable]);

  function reloadDemandData() {
    setMessage("正在重新載入換季需求資料…");
    setReloadToken((current) => current + 1);
  }

  const selectedItem = activeCampaign ? items.find((item) => item.item_id === itemId) : undefined;

  async function saveDemand() {
    if (!identityReady || !client) { setMessage("預覽模式：設定 Supabase env 並登入需求窗口帳號後才能登記。"); return; }
    if (scopeReadBlocked) { setMessage("目前活動範圍尚未完成載入，請稍候或重新載入後再保存。"); return; }
    if (!accountId || !activeCampaign || !employeeId || !itemId || quantity < 0) { setMessage("請選擇活動、員工、品號並輸入不小於 0 的數量。"); return; }
    setBusy(true); setMessage("");
    const employee = visibleEmployees.find((row) => row.employee_id === employeeId);
    const item = selectedItem;
    const operationKey = operationKeyRef.current ?? crypto.randomUUID();
    operationKeyRef.current = operationKey;
    const { data, error } = await client.rpc("upsert_seasonal_demand_line", {
      p_campaign_id: campaignId, p_employee_id: employeeId, p_item_id: itemId, p_quantity: quantity,
      p_note: note.trim() || null, p_idempotency_key: `DEMAND-${operationKey}`,
      p_request_fingerprint: JSON.stringify({ campaignId, employeeId, itemId, quantity, note: note.trim() }),
    });
    setMessage(error ? safeSupabaseMutationErrorMessage(error, "需求登記失敗；若修正欄位後重試會使用新的冪等鍵。") : `已登記 ${employee?.employee_name_snapshot ?? "員工"}／${item?.item_code_snapshot ?? "品號"} ${quantity} ${item?.unit_snapshot ?? ""}。`);
    if (!error) {
      if (data) {
        const savedLine = data as DemandLine;
        setDemandLines((rows) => [...rows.filter((row) => row.id !== savedLine.id), savedLine]);
        setDemandLineId(savedLine.id);
        setQuantity(savedLine.quantity);
        setNote(savedLine.hr_note ?? "");
      }
      operationKeyRef.current = null;
    }
    setBusy(false);
  }

  if (!client) return <section className="panel import-panel" aria-label="換季需求登記"><div className="panel-heading"><div><p className="eyebrow">09 / DEMAND ENTRY</p><h2>換季需求登記</h2></div><span className="status-pill">預覽模式</span></div><p className="auth-message">需求窗口登入後，這裡只會顯示所屬活動與授權員工範圍；送核由 HR 彙整後執行。</p></section>;

  return <section className="panel import-panel" aria-label="換季需求登記">
    <div className="panel-heading"><div><p className="eyebrow">09 / DEMAND ENTRY</p><h2>換季需求登記</h2></div><div className="heading-actions"><span className="status-pill">窗口填寫</span><button className="secondary-button" type="button" onClick={reloadDemandData} disabled={busy}>重新載入資料</button></div></div>
    <p className="auth-message">只能登記目前 OPEN 且在授權範圍內的員工與品號；HR 後續修改會留下異動紀錄。</p>
    {identityError ? <p className="auth-message" role="status">{identityError}</p> : null}
    <div className="seasonal-demand-workspace">
      <div className="seasonal-demand-queue">
        <div className="panel-heading"><div><p className="eyebrow">REGISTERED LINES</p><h3>已登記需求</h3></div><span className="muted">{filteredQueueRows.length} 筆符合</span></div>
        <div className="management-catalog-filters seasonal-demand-filters"><label className="field"><span>搜尋員工／品號／數量／狀態</span><input value={queueQuery} onChange={(event) => { setQueueQuery(event.target.value); setQueuePage(1); }} placeholder="員工編號、姓名、品號或 HR 已修改" /></label></div>
        {visibleDemandLines.length === 0 && !dataLoading
          ? <p className="empty-state">目前活動尚無登記需求，請在右側建立第一筆。</p>
            : filteredQueueRows.length === 0 && !dataLoading
              ? <p className="empty-state">找不到符合條件的需求，請清除搜尋文字。</p>
            : <ManagementCatalogTable
              ariaLabel="換季需求清單"
              rows={sortedQueueRows}
              rowKey={(row) => row.id}
              page={queuePage}
              onPageChange={setQueuePage}
              sortKey={queueSortKey}
              sortDirection={queueSortDirection}
              onSort={sortQueue}
              loading={dataLoading}
              defaultPageSize={10}
              pageSizeOptions={[5, 10, 25, 50]}
              tableClassName="seasonal-demand-table"
              emptyState={<p className="empty-state">目前活動尚無登記需求，請在右側建立第一筆。</p>}
              columns={[
                { id: "employee", label: "員工", locked: true, render: (row) => <><strong>{row.employeeNo}</strong><span className="table-secondary">{row.employeeName}</span></>, sortKey: "employee_no" },
                { id: "item", label: "制服品號", locked: true, render: (row) => <><strong>{row.itemCode}</strong><span className="table-secondary">{row.itemName}{row.size ? `｜${row.size}` : ""}</span></>, sortKey: "item_code" },
                { id: "quantity", label: "數量", render: (row) => row.quantity, sortKey: "quantity", className: "numeric-cell" },
                { id: "status", label: "狀態", render: (row) => <span className={row.hrModified ? "status-pill danger" : "status-pill"}>{row.hrModified ? "HR 已修改" : "已登記"}</span> },
                { id: "updated", label: "更新時間", render: (row) => new Date(row.updatedAt).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" }), sortKey: "updated_at" },
                { id: "action", label: "操作", locked: true, render: (row) => <button className="text-button" type="button" onClick={() => selectDemandLine(row.id)} disabled={busy}>{demandLineId === row.id ? "目前編輯中" : "修改"}</button> },
              ] satisfies readonly ManagementCatalogColumn<SeasonalDemandQueueRow, SeasonalDemandSortKey>[]}
            />}
      </div>
      <div className="seasonal-demand-editor">
        <div className="panel-heading"><div><p className="eyebrow">EDIT WORKSPACE</p><h3>{demandLineId ? "修改需求" : "新增需求"}</h3></div><button className="secondary-button" type="button" onClick={startNewDemand} disabled={busy}>清除表單</button></div>
        <p className="muted">從左側選擇既有列可載入修改；清除表單後可建立新登記。</p>
        <div className="form-grid">
          <label className="field"><span>開放活動</span><select value={campaignId} onChange={(event) => chooseCampaign(event.target.value)} disabled={busy || campaignReadBlocked}><option value="">請選擇</option>{campaigns.map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.campaign_no}｜{campaign.name}（截止 {new Date(campaign.closes_at).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })}）</option>)}</select></label>
          <label className="field"><span>員工</span><select value={employeeId} onChange={(event) => changeEmployee(event.target.value)} disabled={busy || scopeReadBlocked}><option value="">請選擇</option>{visibleEmployees.map((employee) => <option key={employee.employee_id} value={employee.employee_id}>{employee.employee_no_snapshot}｜{employee.employee_name_snapshot}</option>)}</select></label>
          <label className="field"><span>制服品號</span><select value={itemId} onChange={(event) => changeItem(event.target.value)} disabled={busy || scopeReadBlocked}><option value="">請選擇</option>{visibleItems.map((item) => <option key={item.item_id} value={item.item_id}>{item.item_code_snapshot}｜{item.item_name_snapshot}{item.size_snapshot ? `｜${item.size_snapshot}` : ""}</option>)}</select></label>
          <label className="field"><span>需求數量</span><input type="number" min={0} max={999999999} value={quantity} onChange={(event) => { resetOperation(); setQuantity(Math.max(0, Number(event.target.value) || 0)); }} disabled={busy} /></label>
        </div>
        <label className="field"><span>備註（選填）</span><input value={note} onChange={(event) => { resetOperation(); setNote(event.target.value); }} maxLength={2000} disabled={busy} placeholder="例如：新進人員／尺寸特殊" /></label>
        <div className="button-row"><button className="primary-button" type="button" onClick={() => void saveDemand()} disabled={busy || scopeReadBlocked || !campaignId || !employeeId || !itemId}>{busy ? "儲存中…" : scopeReadBlocked ? "等待活動範圍…" : demandLineId ? "更新需求" : "儲存需求"}</button></div>
      </div>
    </div>
    {message ? <p className={message.startsWith("已") ? "success-note" : "auth-message"} role="status">{message}</p> : null}
  </section>;
}
