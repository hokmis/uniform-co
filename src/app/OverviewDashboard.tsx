"use client";

import { useEffect, useMemo, useState } from "react";
import type { WorkspaceId } from "./workspaces/workspace-config";
import { getSupabaseBrowserClient } from "@/src/lib/supabase-browser";

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

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    DRAFT: "草稿",
    SUBMITTED: "待倉庫處理",
    INVENTORY_REVIEW_REQUIRED: "庫存待覆核",
    SHIPPED: "已完成",
    CANCELLED: "已取消",
  };
  return labels[status] ?? status;
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

function ProgressBar({ label, value, tone }: { label: string; value: number; tone: "green" | "blue" | "amber" }) {
  return (
    <div className="overview-progress-item">
      <div className="overview-progress-label"><span>{label}</span><strong>{value}%</strong></div>
      <div className={`overview-progress ${tone}`}><span style={{ width: `${value}%` }} /></div>
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
  const client = getSupabaseBrowserClient();
  const [data, setData] = useState<DashboardData>(emptyData);
  const [loading, setLoading] = useState(Boolean(client));
  const [message, setMessage] = useState("登入後從正式 reporting views 讀取總覽資料");

  useEffect(() => {
    if (!client) return;
    const supabase = client;
    let active = true;

    async function loadDashboard() {
      setLoading(true);
      const [availability, hrRequests, shipments, receipts, distributions, audit] = await Promise.all([
        supabase.from("v_item_availability").select("item_code,item_name,available_to_request_quantity,combined_on_hand_quantity,active_reserved_quantity").limit(300),
        supabase.from("v_hr_request_item_totals").select("request_id,request_no,status,distribution_date,created_at,requested_transfer_quantity").limit(300),
        supabase.from("v_pending_warehouse_shipments").select("shipment_id,shipment_no,request_no,distribution_date,needs_warehouse_attention").limit(300),
        supabase.from("v_purchase_order_receipt_progress").select("purchase_order_id,po_no,ordered_quantity,accepted_to_date,remaining_to_accept").limit(300),
        supabase.from("v_employee_distribution_history").select("employee_no,item_code,quantity_delta,occurred_on,event_kind").limit(300),
        supabase.from("v_audit_event_history").select("id,occurred_at,action,entity_table,entity_id,actor_account_id").limit(20),
      ]);

      if (!active) return;
      const resultErrors = [availability, hrRequests, shipments, receipts, distributions, audit]
        .filter((result) => result.error)
        .map((result) => result.error?.message ?? "報表讀取失敗");
      setData({
        availability: (availability.data ?? []) as Row[],
        hrRequests: (hrRequests.data ?? []) as Row[],
        shipments: (shipments.data ?? []) as Row[],
        receipts: (receipts.data ?? []) as Row[],
        distributions: (distributions.data ?? []) as Row[],
        audit: (audit.data ?? []) as Row[],
        errors: resultErrors,
      });
      setMessage(resultErrors.length > 0 ? `部分摘要受目前角色 RLS 限制（${resultErrors.length} 個來源）` : "數字來自正式 security-invoker reporting views");
      setLoading(false);
    }

    void loadDashboard();
    return () => { active = false; };
  }, [client]);

  const derived = useMemo(() => {
    const requests = uniqueRows(data.hrRequests, "request_id");
    const pendingRequests = requests.filter((row) => ["SUBMITTED", "INVENTORY_REVIEW_REQUIRED"].includes(textValue(row.status, "")));
    const shipments = uniqueRows(data.shipments, "shipment_id");
    const attentionShipments = shipments.filter((row) => row.needs_warehouse_attention === true || String(row.needs_warehouse_attention) === "true");
    const purchaseOrders = uniqueRows(data.receipts, "purchase_order_id");
    const remainingToAccept = data.receipts.reduce((sum, row) => sum + numberValue(row.remaining_to_accept), 0);
    const lowAvailability = data.availability.filter((row) => numberValue(row.available_to_request_quantity) <= 0).length;
    const month = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit" }).format(new Date());
    const monthlyIssued = data.distributions
      .filter((row) => String(row.occurred_on ?? "").slice(0, 7) === month && numberValue(row.quantity_delta) > 0)
      .reduce((sum, row) => sum + numberValue(row.quantity_delta), 0);

    const tasks: DashboardTask[] = [
      ...pendingRequests.slice(0, 3).map((row) => ({
        key: `request-${textValue(row.request_id)}`,
        title: textValue(row.request_no),
        type: "人資需求",
        deadline: dateLabel(row.distribution_date),
        status: statusLabel(textValue(row.status)),
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
    const accepted = data.receipts.reduce((sum, row) => sum + numberValue(row.accepted_to_date), 0);
    const ordered = data.receipts.reduce((sum, row) => sum + numberValue(row.ordered_quantity), 0);
    const healthyAvailability = data.availability.length - lowAvailability;

    return {
      tasks: tasks.slice(0, 8),
      pendingWork: pendingRequests.length + attentionShipments.length + purchaseOrders.filter((row) => numberValue(row.remaining_to_accept) > 0).length,
      monthlyIssued,
      remainingToAccept,
      lowAvailability,
      hrProgress: percent(shippedRequests, requests.length),
      receiptProgress: percent(accepted, ordered),
      availabilityProgress: percent(healthyAvailability, data.availability.length),
    };
  }, [data]);

  return (
    <section className="overview-dashboard" id="overview-dashboard-title" aria-label="營運總覽儀表板">
      <div className="overview-dashboard-heading">
        <div>
          <p className="eyebrow">TODAY / OPERATIONS SNAPSHOT</p>
          <h2>今天的工作台</h2>
          <p>依正式資料來源整理待處理工作、快速入口、跨角色進度與可追溯活動。</p>
        </div>
        <span className={`status-pill ${loading ? "" : "success"}`}>{loading ? "讀取摘要…" : "LIVE / RLS"}</span>
      </div>
      <p className="overview-data-note" role="status">{message}</p>

      <div className="overview-stats">
        <Metric label="待處理工作" value={loading ? "—" : derived.pendingWork} note="需求、發貨與入庫佇列" tone="default" />
        <Metric label="本月發放件數" value={loading ? "—" : derived.monthlyIssued} note="由發放歷史即時計算" tone="blue" />
        <Metric label="待入庫數量" value={loading ? "—" : derived.remainingToAccept} note="採購進度尚未驗收" tone="amber" />
        <Metric label="可申請量異常" value={loading ? "—" : derived.lowAvailability} note="品號可申請量小於等於 0" tone="red" />
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
          <ProgressBar label="人資需求 → 發放完成" value={derived.hrProgress} tone="green" />
          <ProgressBar label="採購 → 正式入庫" value={derived.receiptProgress} tone="blue" />
          <ProgressBar label="可申請品號健康度" value={derived.availabilityProgress} tone="amber" />
        </section>

        <section className="panel overview-activity-panel" aria-label="最近活動">
          <div className="panel-heading"><div><h2>最近活動</h2><p>可追溯的狀態變更摘要</p></div><button className="secondary-button" type="button" onClick={() => onNavigate("reports", "reports-view-title")}>查看全部</button></div>
          {data.audit.length > 0 ? <div className="overview-activity-list">{data.audit.slice(0, 3).map((row) => <div className="overview-activity-row" key={textValue(row.id)}><span className="overview-activity-dot" aria-hidden="true" /><div><p><strong>{textValue(row.action, "狀態變更")}</strong>／{textValue(row.entity_table, "正式資料")}</p><small>{dateLabel(row.occurred_at)}・{textValue(row.actor_account_id, "系統")}</small></div></div>)}</div> : <p className="overview-empty-state">目前沒有可顯示的活動摘要，或目前角色沒有稽核報表讀取權限。</p>}
        </section>
      </div>
    </section>
  );
}
