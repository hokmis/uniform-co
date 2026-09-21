"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { workflowStatusLabel } from "@/src/domain/workflow-status";
import { mergeOverviewReloadScope, overviewReadPlanForScope, overviewReadPresentation, type OverviewReloadScope } from "@/src/domain/overview-refresh";
import { createOverviewReadAheadCoordinator } from "@/src/domain/overview-read-ahead";
import type { WorkspaceId } from "./workspaces/workspace-config";
import { retrySupabaseQueriesAfterSessionRefresh, type SupabaseSessionError } from "@/src/lib/supabase-session";
import { loadOverviewCore, loadOverviewCoreReadAhead, type OverviewCoreReadAhead } from "@/src/lib/overview-dashboard-read";
import { shouldPreserveReadSnapshot, staleReadSnapshotMessage } from "@/src/domain/read-refresh";
import { hrRequestWorkflowChangedEvent } from "@/src/domain/hr-request-events";
import { inventoryDataChangedEvent } from "@/src/domain/inventory-events";
import { usePanelActivity } from "./RetainedPanelSet";
import { useWorkspaceSession } from "./workspace-session";

type Row = Record<string, unknown>;

type DashboardData = {
  availability: Row[];
  hrRequests: Row[];
  shipments: Row[];
  receipts: Row[];
  distributions: Row[];
  audit: Row[];
  errors: string[];
};

type DashboardQuery = PromiseLike<{ data: unknown[] | null; error: SupabaseSessionError | null }>;

type DashboardTask = {
  key: string;
  title: string;
  type: string;
  deadline: string;
  status: string;
  tone: "blue" | "amber" | "green" | "red";
  workspaceId: WorkspaceId;
  anchor: string;
};

type Props = {
  onNavigate: (workspaceId: WorkspaceId, anchor: string) => void;
};

const emptyData: DashboardData = {
  availability: [],
  hrRequests: [],
  shipments: [],
  receipts: [],
  distributions: [],
  audit: [],
  errors: [],
};

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function textValue(value: unknown, fallback = "—"): string {
  return value === null || value === undefined || value === "" ? fallback : String(value);
}

function uniqueRows(rows: Row[], key: string): Row[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const value = textValue(row[key], "");
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function dateLabel(value: unknown): string {
  const date = new Date(String(value));
  if (Number.isNaN(date.valueOf())) return "待確認";
  return new Intl.DateTimeFormat("zh-TW", { month: "2-digit", day: "2-digit", timeZone: "Asia/Taipei" }).format(date);
}

function percent(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((value / total) * 100)));
}

function Metric({ label, value, note, tone }: { label: string; value: string | number; note: string; tone: "default" | "blue" | "amber" | "red" }) {
  return (
    <article className={`overview-stat ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </article>
  );
}

function ProgressBar({ label, value, tone }: { label: string; value: number | null; tone: "green" | "blue" | "amber" }) {
  return (
    <div className="overview-progress-item">
      <div className="overview-progress-label"><span>{label}</span><strong>{value === null ? "—" : `${value}%`}</strong></div>
      <div className={`overview-progress ${tone}`} aria-hidden="true">{value === null ? null : <span style={{ width: `${value}%` }} />}</div>
    </div>
  );
}

function QuickAction({ label, description, mark, onClick }: { label: string; description: string; mark: string; onClick: () => void }) {
  return (
    <button className="overview-quick-action" type="button" onClick={onClick}>
      <span className="overview-quick-mark" aria-hidden="true">{mark}</span>
      <span><strong>{label}</strong><small>{description}</small></span>
    </button>
  );
}

export default function OverviewDashboard({ onNavigate }: Props) {
  const { client, isAuthenticated, authUserId: sessionUserId, accountId, identityError, identityLoading } = useWorkspaceSession();
  const panelActive = usePanelActivity();
  const hasSession = isAuthenticated;
  const identityReady = Boolean(client && panelActive && hasSession && accountId && !identityLoading && !identityError);
  const [coreReadAhead] = useState(() => createOverviewReadAheadCoordinator<OverviewCoreReadAhead>());
  const [data, setData] = useState<DashboardData>(emptyData);
  const [loading, setLoading] = useState(Boolean(client && isAuthenticated));
  const [deferredLoading, setDeferredLoading] = useState(Boolean(client && isAuthenticated));
  const [message, setMessage] = useState("登入後從正式 reporting views 讀取總覽資料");
  const [reloadRequest, setReloadRequest] = useState<{ token: number; scope: OverviewReloadScope }>({ token: 0, scope: "all" });
  const [dataSnapshotAccountId, setDataSnapshotAccountId] = useState<string | null>(null);
  const dataSnapshotAccountIdRef = useRef<string | null>(null);
  const dataRef = useRef<DashboardData>(emptyData);
  const wasPanelActive = useRef(false);
  const pendingReloadScope = useRef<OverviewReloadScope | null>(null);
  const reloadScheduled = useRef(false);

  useEffect(() => {
    if (!client || !sessionUserId || !panelActive || !identityLoading || identityError) return;
    coreReadAhead.start(sessionUserId, () => loadOverviewCoreReadAhead(client, sessionUserId));
  }, [client, coreReadAhead, identityError, identityLoading, panelActive, sessionUserId]);

  useEffect(() => () => {
    if (sessionUserId) coreReadAhead.clear(sessionUserId);
  }, [coreReadAhead, panelActive, sessionUserId]);

  const hasCurrentDataSnapshot = Boolean(
    identityReady
      && dataSnapshotAccountId
      && dataSnapshotAccountId === accountId,
  );
  const visibleData = hasCurrentDataSnapshot ? data : emptyData;

  const queueReload = useCallback((scope: OverviewReloadScope) => {
    pendingReloadScope.current = mergeOverviewReloadScope(pendingReloadScope.current, scope);
    if (reloadScheduled.current) return;
    reloadScheduled.current = true;
    queueMicrotask(() => {
      reloadScheduled.current = false;
      const nextScope = pendingReloadScope.current;
      pendingReloadScope.current = null;
      if (!nextScope) return;
      setReloadRequest((current) => ({ token: current.token + 1, scope: nextScope }));
    });
  }, []);

  useEffect(() => {
    if (!identityReady || !client) {
      wasPanelActive.current = false;
      pendingReloadScope.current = null;
      return;
    }
    const supabase = client;
    const sameAccountSnapshot = dataSnapshotAccountIdRef.current === accountId;
    const scope = sameAccountSnapshot && wasPanelActive.current ? reloadRequest.scope : "all";
    wasPanelActive.current = true;
    let active = true;

    function commitResults(
      results: readonly { key: keyof Pick<DashboardData, "availability" | "hrRequests" | "shipments" | "receipts" | "distributions" | "audit">; rows: Row[]; error: SupabaseSessionError | null }[],
      errors: string[],
    ): boolean {
      const canPreserveSnapshot = dataSnapshotAccountIdRef.current === accountId;
      const previous = canPreserveSnapshot ? dataRef.current : emptyData;
      const next: DashboardData = { ...previous, errors };
      let preserved = false;
      for (const result of results) {
        const preserve = Boolean(result.error && canPreserveSnapshot && shouldPreserveReadSnapshot(previous[result.key], [result.error]));
        next[result.key] = preserve ? previous[result.key] : result.rows;
        preserved ||= preserve;
      }
      dataRef.current = next;
      dataSnapshotAccountIdRef.current = accountId;
      setData(next);
      setDataSnapshotAccountId(accountId);
      return preserved;
    }

    async function loadDashboard() {
      setLoading(true);
      const readFactories: Record<"distributions" | "audit", () => DashboardQuery> = {
        distributions: () => supabase.from("v_employee_distribution_history").select("employee_no,item_code,quantity_delta,occurred_on,event_kind").order("occurred_on", { ascending: false }).limit(300) as unknown as DashboardQuery,
        audit: () => supabase.from("v_audit_event_history").select("id,occurred_at,action,entity_table,entity_id,actor_account_id").order("occurred_at", { ascending: false }).limit(20) as unknown as DashboardQuery,
      };
      const plan = overviewReadPlanForScope(scope);
      const read = async (key: "distributions" | "audit") => {
        const [result] = await retrySupabaseQueriesAfterSessionRefresh(
          supabase,
          async () => [await readFactories[key]()] as const,
        );
        return { key, rows: (result.data ?? []) as Row[], error: result.error };
      };
      setDeferredLoading(plan.deferred.length > 0);

      const coreKeys = ["availability", "hrRequests", "shipments", "receipts"] as const;
      const requestedCoreKeys = coreKeys.filter((key) => plan.primary.includes(key));
      const readAhead = coreReadAhead.take(sessionUserId);
      const prefetchedCore = readAhead ? await readAhead.catch(() => null) : null;
      const prefetchedCoreMatchesIdentity = Boolean(
        prefetchedCore?.authUserId === sessionUserId
          && (prefetchedCore.binding === "auth-user" || prefetchedCore.accountId === accountId),
      );
      const coreRead = prefetchedCoreMatchesIdentity && prefetchedCore
        ? prefetchedCore.result
        : await loadOverviewCore(supabase, requestedCoreKeys);
      const primaryResults = requestedCoreKeys.map((key) => ({
        key,
        rows: coreRead.data[key],
        error: coreRead.errors[key] ?? null,
      }));

      if (!active) return;
      const primaryErrors = primaryResults.filter((result) => result.error).map(() => "報表讀取失敗");
      const preservedPrimary = commitResults(primaryResults, primaryErrors);
      setMessage(primaryErrors.length > 0
        ? preservedPrimary ? staleReadSnapshotMessage("總覽核心摘要") : `部分摘要受目前角色權限限制（${primaryErrors.length} 個來源）`
        : "核心摘要已載入，活動明細背景更新中");
      setLoading(false);

      if (plan.deferred.length === 0) {
        setDeferredLoading(false);
        setMessage(primaryErrors.length > 0 ? `部分摘要受目前角色權限限制（${primaryErrors.length} 個來源）` : "數字來自正式即時資料摘要");
        return;
      }

      const deferredKeys = plan.deferred.filter((key): key is "distributions" | "audit" => key === "distributions" || key === "audit");
      const deferredResults = await Promise.all(deferredKeys.map(read));
      if (!active) return;
      const deferredErrors = deferredResults.filter((result) => result.error).map(() => "報表讀取失敗");
      const preservedDeferred = commitResults(deferredResults, [...primaryErrors, ...deferredErrors]);
      setDeferredLoading(false);
      const totalErrors = primaryErrors.length + deferredErrors.length;
      setMessage(totalErrors > 0
        ? preservedDeferred ? staleReadSnapshotMessage("總覽活動摘要") : `部分摘要受目前角色權限限制（${totalErrors} 個來源）`
        : "數字來自正式即時資料摘要");
    }

    void loadDashboard();
    return () => { active = false; };
  }, [accountId, client, coreReadAhead, identityError, identityReady, panelActive, reloadRequest, sessionUserId]);

  useEffect(() => {
    if (!identityReady || !client) return;
    const refreshInventory = () => queueReload("inventory");
    const refreshWorkflow = () => queueReload("workflow");
    window.addEventListener(inventoryDataChangedEvent, refreshInventory);
    window.addEventListener(hrRequestWorkflowChangedEvent, refreshWorkflow);
    return () => {
      window.removeEventListener(inventoryDataChangedEvent, refreshInventory);
      window.removeEventListener(hrRequestWorkflowChangedEvent, refreshWorkflow);
    };
  }, [client, identityReady, queueReload]);

  const readPresentation = overviewReadPresentation({
    hasSession,
    identityReady,
    identityError: Boolean(identityError),
    hasCurrentSnapshot: hasCurrentDataSnapshot,
    coreLoading: loading,
    deferredLoading,
  });
  const displayMessage = identityError ?? message;

  const derived = useMemo(() => {
    const requests = uniqueRows(visibleData.hrRequests, "request_id");
    const pendingRequests = requests.filter((row) => ["SUBMITTED", "INVENTORY_REVIEW_REQUIRED"].includes(textValue(row.status, "")));
    const shipments = uniqueRows(visibleData.shipments, "shipment_id");
    const attentionShipments = shipments.filter((row) => row.needs_warehouse_attention === true || String(row.needs_warehouse_attention) === "true");
    const purchaseOrders = uniqueRows(visibleData.receipts, "purchase_order_id");
    const remainingToAccept = visibleData.receipts.reduce((sum, row) => sum + numberValue(row.remaining_to_accept), 0);
    const lowAvailability = visibleData.availability.filter((row) => numberValue(row.available_to_request_quantity) <= 0).length;
    const month = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit" }).format(new Date());
    const monthlyIssued = visibleData.distributions
      .filter((row) => String(row.occurred_on ?? "").slice(0, 7) === month && numberValue(row.quantity_delta) > 0)
      .reduce((sum, row) => sum + numberValue(row.quantity_delta), 0);

    const tasks: DashboardTask[] = [
      ...pendingRequests.slice(0, 3).map((row) => ({
        key: `request-${textValue(row.request_id)}`,
        title: textValue(row.request_no),
        type: "人資需求",
        deadline: dateLabel(row.distribution_date),
        status: workflowStatusLabel(textValue(row.status)),
        tone: textValue(row.status) === "INVENTORY_REVIEW_REQUIRED" ? "red" as const : "blue" as const,
        workspaceId: "hr" as const,
        anchor: "hr-request-title",
      })),
      ...shipments.slice(0, 3).map((row) => ({
        key: `shipment-${textValue(row.shipment_id)}`,
        title: textValue(row.shipment_no),
        type: "倉庫發貨",
        deadline: dateLabel(row.distribution_date),
        status: row.needs_warehouse_attention === true || String(row.needs_warehouse_attention) === "true" ? "需注意" : "待理貨",
        tone: row.needs_warehouse_attention === true || String(row.needs_warehouse_attention) === "true" ? "amber" as const : "blue" as const,
        workspaceId: "warehouse" as const,
        anchor: "warehouse-control-title",
      })),
      ...purchaseOrders.slice(0, 3).map((row) => ({
        key: `receipt-${textValue(row.purchase_order_id)}`,
        title: textValue(row.po_no),
        type: "採購入庫",
        deadline: `${numberValue(row.remaining_to_accept)} 件待收`,
        status: "待入庫",
        tone: "amber" as const,
        workspaceId: "procurement" as const,
        anchor: "procurement-receipt-title",
      })),
    ];

    const shippedRequests = requests.filter((row) => textValue(row.status) === "SHIPPED").length;
    const accepted = visibleData.receipts.reduce((sum, row) => sum + numberValue(row.accepted_to_date), 0);
    const ordered = visibleData.receipts.reduce((sum, row) => sum + numberValue(row.ordered_quantity), 0);
    const healthyAvailability = visibleData.availability.length - lowAvailability;

    return {
      tasks: tasks.slice(0, 8),
      pendingWork: pendingRequests.length + attentionShipments.length + purchaseOrders.filter((row) => numberValue(row.remaining_to_accept) > 0).length,
      monthlyIssued,
      remainingToAccept,
      lowAvailability,
      hrProgress: percent(shippedRequests, requests.length),
      receiptProgress: percent(accepted, ordered),
      availabilityProgress: percent(healthyAvailability, visibleData.availability.length),
    };
  }, [visibleData]);

  return (
    <section className="overview-dashboard" id="overview-dashboard-title" aria-label="營運總覽儀表板" aria-busy={readPresentation.busy}>
      <div className="overview-dashboard-heading">
        <div>
          <p className="eyebrow">TODAY / OPERATIONS SNAPSHOT</p>
          <h2>今天的工作台</h2>
          <p>依正式資料來源整理待處理工作、快速入口、跨角色進度與可追溯活動。</p>
        </div>
        <div className="heading-actions"><span className={`status-pill ${readPresentation.busy ? "" : "success"}`}>{readPresentation.showCorePlaceholder ? "讀取核心摘要…" : readPresentation.coreRefreshing ? "背景更新中，顯示已載入資料" : readPresentation.showActivityPlaceholder ? "補齊活動摘要…" : "即時資料"}</span><button className="secondary-button" type="button" onClick={() => queueReload("all")} disabled={!identityReady}>重新整理總覽</button></div>
      </div>
      <p className="overview-data-note" role="status">{displayMessage}</p>

      <div className="overview-stats">
        <Metric label="待處理工作" value={readPresentation.showCorePlaceholder ? "—" : derived.pendingWork} note="需求、發貨與入庫佇列" tone="default" />
        <Metric label="本月發放件數" value={readPresentation.showActivityPlaceholder ? "—" : derived.monthlyIssued} note="由發放歷史即時計算" tone="blue" />
        <Metric label="待入庫數量" value={readPresentation.showCorePlaceholder ? "—" : derived.remainingToAccept} note="採購進度尚未驗收" tone="amber" />
        <Metric label="可申請量異常" value={readPresentation.showCorePlaceholder ? "—" : derived.lowAvailability} note="品號可申請量小於等於 0" tone="red" />
      </div>

      <div className="overview-dashboard-grid">
        <section className="panel overview-queue-panel" aria-label="今天的工作佇列">
          <div className="panel-heading">
            <div><h2>今天的工作佇列</h2><p>依正式 view 的狀態與期限排序，點擊可進入對應模組。</p></div>
            <button className="secondary-button" type="button" onClick={() => onNavigate("hr", "hr-request-title")}>建立工作</button>
          </div>
          {derived.tasks.length > 0 ? (
            <div className="overview-table-scroll">
              <table className="overview-table">
                <thead><tr><th>工作項目</th><th>類型</th><th>期限／數量</th><th>狀態</th></tr></thead>
                <tbody>{derived.tasks.map((task) => <tr key={task.key}>
                  <td><button className="overview-table-link" type="button" onClick={() => onNavigate(task.workspaceId, task.anchor)}>{task.title}</button></td>
                  <td>{task.type}</td><td>{task.deadline}</td><td><span className={`overview-status ${task.tone}`}>{task.status}</span></td>
                </tr>)}</tbody>
              </table>
            </div>
          ) : <p className="overview-empty-state">目前沒有可顯示的待處理工作，或目前角色沒有對應報表讀取權限。</p>}
        </section>

        <section className="panel overview-quick-panel" aria-label="快速入口">
          <div className="panel-heading"><div><h2>快速入口</h2><p>直接進入最常用的正式流程</p></div></div>
          <div className="overview-quick-actions">
            <QuickAction label="建立人資需求" description="新增員工制服申請與預留" mark="人" onClick={() => onNavigate("hr", "hr-request-title")} />
            <QuickAction label="查看庫存" description="檢視兩倉帳面量與可申請量" mark="量" onClick={() => onNavigate("warehouse", "warehouse-inventory-title")} />
            <QuickAction label="開始倉庫盤點" description="建立盤點批次並鎖定帳面量" mark="倉" onClick={() => onNavigate("warehouse", "warehouse-stocktake-title")} />
            <QuickAction label="管理商品" description="維護品號、供應商與 MOQ" mark="品" onClick={() => onNavigate("overview", "overview-products-title")} />
            <QuickAction label="匯入主檔" description="上傳資料並確認正式差異" mark="匯" onClick={() => onNavigate("overview", "overview-import-title")} />
            <QuickAction label="管理帳號" description="角色、狀態與窗口範圍" mark="權" onClick={() => onNavigate("accounts", "accounts-admin-title")} />
          </div>
        </section>
      </div>

      <div className="overview-dashboard-grid">
        <section className="panel overview-progress-panel" aria-label="本月作業進度">
          <div className="panel-heading"><div><h2>本月作業進度</h2><p>依目前可讀取的正式資料來源計算</p></div><span className="status-pill success">即時計算</span></div>
          <ProgressBar label="人資需求 → 發放完成" value={readPresentation.showCorePlaceholder ? null : derived.hrProgress} tone="green" />
          <ProgressBar label="採購 → 正式入庫" value={readPresentation.showCorePlaceholder ? null : derived.receiptProgress} tone="blue" />
          <ProgressBar label="可申請品號健康度" value={readPresentation.showCorePlaceholder ? null : derived.availabilityProgress} tone="amber" />
        </section>

        <section className="panel overview-activity-panel" aria-label="最近活動">
          <div className="panel-heading"><div><h2>最近活動</h2><p>可追溯的狀態變更摘要</p></div><button className="secondary-button" type="button" onClick={() => onNavigate("reports", "reports-view-title")}>查看全部</button></div>
          {readPresentation.showActivityPlaceholder ? <p className="overview-empty-state">活動摘要載入中…</p> : visibleData.audit.length > 0 ? <div className="overview-activity-list">{visibleData.audit.slice(0, 3).map((row) => <div className="overview-activity-row" key={textValue(row.id)}><span className="overview-activity-dot" aria-hidden="true" /><div><p><strong>{textValue(row.action, "狀態變更")}</strong>／{textValue(row.entity_table, "正式資料")}</p><small>{dateLabel(row.occurred_at)}・{textValue(row.actor_account_id, "系統")}</small></div></div>)}</div> : <p className="overview-empty-state">目前沒有可顯示的活動摘要，或目前角色沒有稽核報表讀取權限。</p>}
        </section>
      </div>
    </section>
  );
}
