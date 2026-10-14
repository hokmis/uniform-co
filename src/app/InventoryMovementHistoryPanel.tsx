"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ManagementCatalogTable, { type ManagementCatalogColumn } from "./ManagementCatalogTable";
import {
  aggregateStockMovements,
  filterStockMovements,
  sortStockMovements,
  ALL_POSTING_KINDS,
  type StockMovementFilter,
  type StockMovementPostingKind,
  type StockMovementRow,
  type StockMovementSortDirection,
  type StockMovementSortKey,
} from "@/src/domain/stock-movement-history";
import { hrRequestWorkflowChangedEvent } from "@/src/domain/hr-request-events";
import { inventoryDataChangedEvent } from "@/src/domain/inventory-events";
import { retrySupabaseQueriesAfterSessionRefresh, safeSupabaseReadErrorMessage } from "@/src/lib/supabase-session";
import { getDefaultHrRequestDateRange } from "@/src/domain/hr-request-history";
import {
  generateInventoryAuditXlsx,
  downloadInventoryAuditXlsx,
  type InventoryAuditRow,
  type InventoryAuditExportOptions,
} from "@/src/domain/inventory-audit-export";
import { usePanelActivity } from "./RetainedPanelSet";
import { useWorkspaceSession } from "./workspace-session";
import HrRequestDetailModal from "./HrRequestDetailModal";

function formatDelta(delta: number, unit: string) {
  if (delta > 0) {
    return <span style={{ color: "#16a34a", fontWeight: 600 }}>+{delta} {unit}</span>;
  }
  if (delta < 0) {
    return <span style={{ color: "#dc2626", fontWeight: 600 }}>{delta} {unit}</span>;
  }
  return <span className="muted">0 {unit}</span>;
}

function formatTaipeiDateTime(postedAt: string, occurredOn: string): string {
  if (!postedAt) return occurredOn || "—";
  const date = new Date(postedAt);
  if (Number.isNaN(date.getTime())) {
    return occurredOn || postedAt;
  }
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date).replace(/\//g, "-");
}

function getPostingBadgeStyle(kind: StockMovementPostingKind): { background: string; color: string } {
  switch (kind) {
    case "HR_REQUEST_RESERVATION":
      return { background: "#f3e8ff", color: "#7e22ce" };
    case "WAREHOUSE_SHIPMENT":
      return { background: "#fef3c7", color: "#92400e" };
    case "REPLENISHMENT":
      return { background: "#e0f2fe", color: "#0369a1" };
    case "HR_ISSUE_CORRECTION":
      return { background: "#ffedd5", color: "#c2410c" };
    case "RETURN":
      return { background: "#dcfce7", color: "#15803d" };
    case "RETURN_CORRECTION":
      return { background: "#ccfbf1", color: "#0f766e" };
    case "RECEIPT":
      return { background: "#dbeafe", color: "#1e40af" };
    case "PURCHASE_RECEIPT_CORRECTION":
      return { background: "#e0e7ff", color: "#3730a3" };
    case "STOCKTAKE":
      return { background: "#fce7f3", color: "#9d174d" };
    case "STOCKTAKE_CORRECTION":
      return { background: "#ffe4e6", color: "#9f1239" };
    case "ADJUSTMENT":
      return { background: "#f1f5f9", color: "#334155" };
    case "TRANSFER_CORRECTION":
      return { background: "#ede9fe", color: "#5b21b6" };
    case "OPENING":
      return { background: "#ecfccb", color: "#3f6212" };
    default:
      return { background: "#f1f5f9", color: "#475569" };
  }
}

export default function InventoryMovementHistoryPanel() {
  const { client, isAuthenticated, accountId, identityError, identityLoading } = useWorkspaceSession();
  const panelActive = usePanelActivity();
  const [rows, setRows] = useState<StockMovementRow[]>([]);
  const [query, setQuery] = useState("");
  const [selectedPostingKinds, setSelectedPostingKinds] = useState<StockMovementPostingKind[]>([]);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const kindCounts = useMemo(() => {
    const counts: Partial<Record<StockMovementPostingKind, number>> = {};
    for (const r of rows) {
      counts[r.postingKind] = (counts[r.postingKind] || 0) + 1;
    }
    return counts;
  }, [rows]);
  const [sortKey, setSortKey] = useState<StockMovementSortKey>("posted_at");
  const [sortDirection, setSortDirection] = useState<StockMovementSortDirection>("desc");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [modalTarget, setModalTarget] = useState<{
    isOpen: boolean;
    sourceNo: string;
    postingId?: string;
    postingKind?: StockMovementPostingKind;
  }>({ isOpen: false, sourceNo: "" });

  const identityReady = Boolean(client && panelActive && isAuthenticated && accountId && !identityLoading && !identityError);

  async function loadData() {
    if (!client || !identityReady) return;
    await Promise.resolve();
    setLoading(true);

    try {
      const [historyResult, availabilityResult, pendingRequestsResult] = await retrySupabaseQueriesAfterSessionRefresh(
        client,
        () => Promise.all([
          client
            .from("v_inventory_history")
            .select("ledger_entry_id,posting_id,line_no,warehouse_id,warehouse_code,warehouse_name,warehouse_purpose,item_id,item_code,item_name,unit,posting_kind,movement_kind,quantity_delta,occurred_on,source_no,posted_by_name,posted_at,current_on_hand_quantity")
            .in("posting_kind", [
              "WAREHOUSE_SHIPMENT",
              "REPLENISHMENT",
              "CORRECTION",
              "RETURN",
              "RECEIPT",
              "STOCKTAKE",
              "ADJUSTMENT",
              "OPENING",
            ])
            .order("posted_at", { ascending: false })
            .limit(2000),
          client
            .from("v_item_availability")
            .select("item_id,item_code,item_name,size,unit,hr_on_hand_quantity,general_on_hand_quantity")
            .limit(1000),
          client
            .from("v_hr_request_item_totals")
            .select("request_id,request_no,status,distribution_date,created_at,item_id,item_code,item_name,unit,issue_quantity")
            .eq("status", "SUBMITTED")
            .gt("issue_quantity", 0)
            .limit(1000),
        ]),
      );

      if (historyResult.error) {
        setMessage(`載入庫存異動流水失敗：${safeSupabaseReadErrorMessage(historyResult.error)}`);
        setLoading(false);
        return;
      }

      const historyData = (historyResult.data ?? []) as Array<Record<string, unknown>>;
      const availabilityData = (availabilityResult?.data ?? []) as Array<Record<string, unknown>>;
      const pendingData = (pendingRequestsResult?.data ?? []) as Array<Record<string, unknown>>;

      const aggregated = aggregateStockMovements(historyData, availabilityData, pendingData);
      setRows(aggregated);
      setMessage(`已載入 ${aggregated.length} 筆進出貨異動紀錄（包含全流程發貨、補庫、退回、採購入庫、盤點、庫存調整與更正單據）`);
    } catch (err) {
      setMessage(`讀取進出貨紀錄異常：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  const [exportingAudit, setExportingAudit] = useState(false);

  async function handleExportAuditTable() {
    if (!client) {
      setMessage("預覽模式：尚未連接資料庫，無法匯出。");
      return;
    }
    setExportingAudit(true);
    setMessage("正在計算指定區間之制服庫存簽核表資料…");

    try {
      // 1. 決定日期區間
      const defaultRange = getDefaultHrRequestDateRange();
      const effectiveStartDate = startDate || defaultRange.startDate;
      const effectiveEndDate = endDate || defaultRange.endDate;

      // 解析年度與月份（以結束日期之年月為簽核表基準）
      const endParts = effectiveEndDate.split("-");
      const curYear = parseInt(endParts[0], 10) || new Date().getFullYear();
      const curMonth = parseInt(endParts[1], 10) || (new Date().getMonth() + 1);
      const prevMonth = curMonth === 1 ? 12 : curMonth - 1;

      // 2. 查詢全量啟用品項與當前兩倉現存量 (v_item_availability)
      //    以及指定區間內的未取消需求單 (hr_requests) 與補庫單 (replenishment_requests)
      const [availRes, hrReqsRes, repReqsRes] = await retrySupabaseQueriesAfterSessionRefresh(
        client,
        () => Promise.all([
          client
            .from("v_item_availability")
            .select("item_id, item_code, item_name, size, unit, hr_on_hand_quantity, general_on_hand_quantity")
            .limit(2000),
          client
            .from("hr_requests")
            .select("id, status, distribution_date, created_at")
            .neq("status", "CANCELLED")
            .gte("distribution_date", effectiveStartDate)
            .lte("distribution_date", effectiveEndDate)
            .limit(2000),
          client
            .from("replenishment_requests")
            .select("id, status, created_at")
            .neq("status", "CANCELLED")
            .gte("created_at", `${effectiveStartDate}T00:00:00`)
            .lte("created_at", `${effectiveEndDate}T23:59:59`)
            .limit(2000),
        ]),
      );

      if (availRes.error) {
        setMessage(`讀取制服品項庫存失敗：${safeSupabaseReadErrorMessage(availRes.error)}`);
        setExportingAudit(false);
        return;
      }

      const activeItems = (availRes.data ?? []) as Array<{
        item_id: string;
        item_code: string;
        item_name: string;
        size: string | null;
        unit: string | null;
        hr_on_hand_quantity: number | null;
        general_on_hand_quantity: number | null;
      }>;

      // 3. 抓取區間內需求單之發放量 (hr_issue_lines) 與增庫量 (hr_request_items)
      const validHrReqIds = ((hrReqsRes?.data ?? []) as Array<{ id: string }>).map((r) => r.id);
      const validRepReqIds = ((repReqsRes?.data ?? []) as Array<{ id: string }>).map((r) => r.id);

      const issueQtyByItem = new Map<string, number>();
      const increaseQtyByItem = new Map<string, number>();
      const replenishQtyByItem = new Map<string, number>();

      if (validHrReqIds.length > 0) {
        const [linesRes, itemsRes] = await retrySupabaseQueriesAfterSessionRefresh(
          client,
          () => Promise.all([
            client
              .from("hr_issue_lines")
              .select("item_id, quantity")
              .in("request_id", validHrReqIds),
            client
              .from("hr_request_items")
              .select("item_id, increase_quantity")
              .in("request_id", validHrReqIds),
          ]),
        );

        for (const line of (linesRes?.data ?? []) as Array<{ item_id: string; quantity: number | null }>) {
          if (!line.item_id) continue;
          const prev = issueQtyByItem.get(line.item_id) || 0;
          issueQtyByItem.set(line.item_id, prev + (Number(line.quantity) || 0));
        }

        for (const it of (itemsRes?.data ?? []) as Array<{ item_id: string; increase_quantity: number | null }>) {
          if (!it.item_id) continue;
          const prev = increaseQtyByItem.get(it.item_id) || 0;
          increaseQtyByItem.set(it.item_id, prev + (Number(it.increase_quantity) || 0));
        }
      }

      // 3.1 抓取區間內已過帳之人資發放更正 (issue_correction_lines)，並納入發放量計算
      const [correctionsRes] = await retrySupabaseQueriesAfterSessionRefresh(
        client,
        () => Promise.all([
          client
            .from("correction_notes")
            .select("id, status, posted_at, issue_correction_lines(item_id, issue_quantity_delta)")
            .eq("correction_kind", "HR_ISSUE")
            .eq("status", "POSTED")
            .gte("posted_at", `${effectiveStartDate}T00:00:00`)
            .lte("posted_at", `${effectiveEndDate}T23:59:59`)
            .limit(2000),
        ]),
      );

      if (correctionsRes?.data) {
        for (const note of (correctionsRes.data as Array<Record<string, unknown>>)) {
          const cLines = (note.issue_correction_lines ?? []) as Array<{ item_id: string; issue_quantity_delta: number | null }>;
          for (const cl of cLines) {
            if (!cl.item_id) continue;
            const prev = issueQtyByItem.get(cl.item_id) || 0;
            issueQtyByItem.set(cl.item_id, prev + (Number(cl.issue_quantity_delta) || 0));
          }
        }
      }

      // 4. 抓取區間內補庫單之補貨量 (replenishment_request_lines)
      if (validRepReqIds.length > 0) {
        const [repLinesRes] = await retrySupabaseQueriesAfterSessionRefresh(
          client,
          () => Promise.all([
            client
              .from("replenishment_request_lines")
              .select("item_id, requested_quantity, actual_transfer_quantity")
              .in("request_id", validRepReqIds),
          ]),
        );

        for (const rLine of (repLinesRes?.data ?? []) as Array<{
          item_id: string;
          requested_quantity: number | null;
          actual_transfer_quantity: number | null;
        }>) {
          if (!rLine.item_id) continue;
          const prev = replenishQtyByItem.get(rLine.item_id) || 0;
          // 若有 actual_transfer_quantity 則以實際調撥為準，否則以 requested_quantity 為準
          const qty = Number(rLine.actual_transfer_quantity ?? rLine.requested_quantity) || 0;
          replenishQtyByItem.set(rLine.item_id, prev + qty);
        }
      }

      // 5. 組裝 InventoryAuditRow
      const auditRows: InventoryAuditRow[] = activeItems.map((item) => {
        const itemId = item.item_id;
        const hrOnHand = Number(item.hr_on_hand_quantity) || 0;
        const genOnHand = Number(item.general_on_hand_quantity) || 0;
        const issueQty = issueQtyByItem.get(itemId) || 0;
        const increaseQty = increaseQtyByItem.get(itemId) || 0;
        const replenishQty = replenishQtyByItem.get(itemId) || 0;

        // 期初反推：
        // 人資期初 + 增庫量 + 補貨量 - 發放量 = 人資現存 => 人資期初 = 人資現存 + 發放量 - 增庫量 - 補貨量
        const hrOpening = hrOnHand + issueQty - increaseQty - replenishQty;
        // 總倉發貨量 = 增庫量 + 補貨量
        const genIssueQty = increaseQty + replenishQty;
        // 總倉期初 - 總倉發貨量 = 總倉現存 => 總倉期初 = 總倉現存 + 總倉發貨量
        const genOpening = genOnHand + genIssueQty;
        const combinedOnHand = hrOnHand + genOnHand;
        const erpOnHand = combinedOnHand;

        return {
          itemId,
          itemCode: item.item_code || "",
          itemName: item.item_name || "",
          size: item.size || "",
          unit: item.unit || "件",
          hrOpening,
          issueQty,
          increaseQty,
          replenishQty,
          hrOnHand,
          genOpening,
          genIssueQty,
          genOnHand,
          combinedOnHand,
          erpOnHand,
        };
      });

      const options: InventoryAuditExportOptions = {
        year: curYear,
        month: curMonth,
        prevMonth,
        startDate: effectiveStartDate,
        endDate: effectiveEndDate,
      };

      const xlsxBytes = generateInventoryAuditXlsx(auditRows, options);
      const filename = `${curYear}年${curMonth}月-制服庫存簽核表.xlsx`;
      downloadInventoryAuditXlsx(xlsxBytes, filename);

      setMessage(`已成功匯出 ${filename}（共 ${auditRows.length} 個品項，統計區間：${effectiveStartDate} ～ ${effectiveEndDate}）`);
    } catch (err) {
      setMessage(`匯出制服庫存簽核表異常：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExportingAudit(false);
    }
  }

  useEffect(() => {
    let active = true;
    if (identityReady) {
      queueMicrotask(() => {
        if (active) void loadData();
      });
    }
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityReady]);

  useEffect(() => {
    if (!client || !panelActive) return;
    let active = true;
    const refreshData = () => {
      queueMicrotask(() => {
        if (active) void loadData();
      });
    };
    window.addEventListener(hrRequestWorkflowChangedEvent, refreshData);
    window.addEventListener(inventoryDataChangedEvent, refreshData);
    return () => {
      active = false;
      window.removeEventListener(hrRequestWorkflowChangedEvent, refreshData);
      window.removeEventListener(inventoryDataChangedEvent, refreshData);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, panelActive, identityReady]);

  const filteredRows = useMemo(() => {
    const filter: StockMovementFilter = {
      query,
      postingKinds: selectedPostingKinds,
      startDate,
      endDate,
    };
    return filterStockMovements(rows, filter);
  }, [endDate, query, rows, selectedPostingKinds, startDate]);

  const sortedRows = useMemo(() => {
    return sortStockMovements(filteredRows, sortKey, sortDirection);
  }, [filteredRows, sortDirection, sortKey]);

  function toggleSort(nextKey: StockMovementSortKey) {
    if (sortKey === nextKey) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(nextKey);
      setSortDirection("asc");
    }
    setPage(1);
  }

  if (!client) {
    return (
      <section className="panel" aria-label="進出貨紀錄">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">MOVEMENT HISTORY</p>
            <h2>進出貨紀錄</h2>
          </div>
          <span className="status-pill">預覽模式</span>
        </div>
        <p className="auth-message">登入倉庫或管理者帳號後，這裡會顯示需求單發貨與額外補庫造成的庫存異動紀錄。</p>
      </section>
    );
  }

  return (
    <section className="panel inventory-movement-history-panel" aria-label="進出貨紀錄">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">MOVEMENT HISTORY</p>
          <h2>進出貨紀錄</h2>
        </div>
        <span className="status-pill">流水紀錄</span>
      </div>
      <p className="auth-message">
        即時追蹤全系統所有影響兩倉數量的進出貨與庫存異動，包含員工需求發貨、額外補庫調撥、需求預留、制服退回、廠商採購入庫、倉庫盤點盈虧、庫存調整及各類更正作業。
      </p>

      <div className="inventory-toolbar hr-request-history-toolbar">
        <label className="field">
          <span>搜尋品名／品號／單號</span>
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
            placeholder="例如 短袖、SHP 或 REP"
          />
        </label>
        <label className="field">
          <span>單據類型</span>
          <select
            value={
              selectedPostingKinds.length === 0
                ? "ALL"
                : selectedPostingKinds.length === 1
                  ? selectedPostingKinds[0]
                  : "MULTI"
            }
            onChange={(event) => {
              const val = event.target.value;
              if (val === "ALL") {
                setSelectedPostingKinds([]);
              } else if (val !== "MULTI") {
                setSelectedPostingKinds([val as StockMovementPostingKind]);
              }
              setPage(1);
            }}
          >
            <option value="ALL">全部單據類型</option>
            {selectedPostingKinds.length > 1 && (
              <option value="MULTI" disabled>
                已選取多標籤 ({selectedPostingKinds.length})
              </option>
            )}
            <option value="HR_REQUEST_RESERVATION">需求預留(待發貨)</option>
            <option value="WAREHOUSE_SHIPMENT">員工需求發貨</option>
            <option value="REPLENISHMENT">額外補庫調撥</option>
            <option value="HR_ISSUE_CORRECTION">人資發放更正</option>
            <option value="RETURN">員工制服退回</option>
            <option value="RETURN_CORRECTION">退回更正</option>
            <option value="RECEIPT">廠商採購入庫</option>
            <option value="PURCHASE_RECEIPT_CORRECTION">採購驗收更正</option>
            <option value="STOCKTAKE">倉庫盤點盈虧</option>
            <option value="STOCKTAKE_CORRECTION">盤點更正</option>
            <option value="ADJUSTMENT">庫存調整</option>
            <option value="TRANSFER_CORRECTION">調撥更正</option>
            <option value="OPENING">期初開帳導入</option>
          </select>
        </label>
        <label className="field">
          <span>起始日期</span>
          <input
            type="date"
            value={startDate}
            onChange={(event) => {
              setStartDate(event.target.value);
              setPage(1);
            }}
            aria-label="依起始年月日查詢"
          />
        </label>
        <label className="field">
          <span>結束日期</span>
          <input
            type="date"
            value={endDate}
            onChange={(event) => {
              setEndDate(event.target.value);
              setPage(1);
            }}
            aria-label="依結束年月日查詢"
          />
        </label>
        <div className="inventory-toolbar-action" style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <button className="secondary-button" type="button" onClick={() => void loadData()}>
            {loading ? "讀取中…" : "重新整理"}
          </button>
          <button
            className="secondary-button"
            type="button"
            onClick={() => void handleExportAuditTable()}
            disabled={exportingAudit || !identityReady}
            title="依指定區間（預設與需求單查詢相同）匯出包含兩倉期初、發放量、增庫量、補貨量與期末簽核表"
          >
            {exportingAudit ? "稽核表匯出中…" : "匯出制服領用稽核表(Excel)"}
          </button>
        </div>
      </div>

      {/* 13 種庫存異動標籤化篩選區塊 */}
      <div
        className="stock-movement-tag-filter"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "8px",
          margin: "12px 0 6px",
          padding: "10px 14px",
          background: "#f8fafc",
          borderRadius: "8px",
          border: "1px solid #e2e8f0",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: "0.85rem", fontWeight: 700, color: "#1e293b" }}>
              單據標籤篩選：
            </span>
            <span style={{ fontSize: "0.8rem", color: "#64748b" }}>
              {selectedPostingKinds.length === 0
                ? "（目前顯示全部單據，點選任一標籤可單選或多選組合篩選）"
                : `（已選取 ${selectedPostingKinds.length} 個標籤）`}
            </span>
          </div>
          {selectedPostingKinds.length > 0 && (
            <button
              type="button"
              style={{
                border: "none",
                background: "none",
                color: "#2563eb",
                fontSize: "0.8rem",
                cursor: "pointer",
                padding: 0,
                textDecoration: "underline",
                fontWeight: 600,
              }}
              onClick={() => {
                setSelectedPostingKinds([]);
                setPage(1);
              }}
            >
              重設為全部標籤
            </button>
          )}
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center" }}>
          {/* 全部標籤按鈕 */}
          <button
            type="button"
            onClick={() => {
              setSelectedPostingKinds([]);
              setPage(1);
            }}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "4px 10px",
              borderRadius: "16px",
              fontSize: "0.8rem",
              fontWeight: selectedPostingKinds.length === 0 ? 700 : 500,
              cursor: "pointer",
              border: selectedPostingKinds.length === 0 ? "1.5px solid #0f172a" : "1px solid #cbd5e1",
              background: selectedPostingKinds.length === 0 ? "#0f172a" : "#ffffff",
              color: selectedPostingKinds.length === 0 ? "#ffffff" : "#475569",
              transition: "all 0.15s ease",
            }}
          >
            全部 ({rows.length})
          </button>

          {/* 13 種庫存異動標籤 */}
          {ALL_POSTING_KINDS.map(({ kind, label }) => {
            const isSelected = selectedPostingKinds.includes(kind);
            const style = getPostingBadgeStyle(kind);
            const count = kindCounts[kind] || 0;

            return (
              <button
                key={kind}
                type="button"
                onClick={() => {
                  setPage(1);
                  setSelectedPostingKinds((prev) => {
                    if (prev.includes(kind)) {
                      return prev.filter((k) => k !== kind);
                    }
                    return [...prev, kind];
                  });
                }}
                title={`點擊${isSelected ? "取消篩選" : "篩選"} ${label}`}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "4px 10px",
                  borderRadius: "16px",
                  fontSize: "0.8rem",
                  fontWeight: isSelected ? 700 : 500,
                  cursor: "pointer",
                  transition: "all 0.15s ease",
                  background: isSelected ? style.background : "#ffffff",
                  color: isSelected ? style.color : "#475569",
                  border: isSelected
                    ? `2px solid ${style.color}`
                    : "1px solid #e2e8f0",
                  boxShadow: isSelected ? "0 1px 3px rgba(0,0,0,0.12)" : "none",
                  opacity: selectedPostingKinds.length === 0 || isSelected ? 1 : 0.65,
                }}
              >
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    backgroundColor: style.color,
                    display: "inline-block",
                  }}
                />
                <span>{label}</span>
                <span
                  style={{
                    fontSize: "0.75rem",
                    padding: "1px 5px",
                    borderRadius: 8,
                    background: isSelected ? "rgba(0,0,0,0.08)" : "#f1f5f9",
                    color: isSelected ? style.color : "#64748b",
                    fontWeight: 600,
                  }}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="management-catalog-result">
        <p className="muted" role="status">
          {message || "尚未載入"}；符合條件 {sortedRows.length} 筆
        </p>
        {(query || selectedPostingKinds.length > 0 || startDate || endDate) ? (
          <button
            className="text-button"
            type="button"
            onClick={() => {
              setQuery("");
              setSelectedPostingKinds([]);
              setStartDate("");
              setEndDate("");
              setPage(1);
            }}
          >
            清除篩選
          </button>
        ) : null}
      </div>

      <ManagementCatalogTable<StockMovementRow, StockMovementSortKey>
        ariaLabel="進出貨紀錄表"
        rows={sortedRows}
        rowKey={(row) => row.id}
        page={page}
        onPageChange={setPage}
        sortKey={sortKey}
        sortDirection={sortDirection}
        onSort={toggleSort}
        loading={loading && rows.length === 0}
        defaultPageSize={10}
        pageSizeOptions={[10, 25, 50, 100]}
        tableClassName="inventory-movement-table"
        emptyState={<p className="empty-state">目前沒有符合條件的進出貨紀錄。</p>}
        columns={[
          {
            id: "source",
            label: "單據／時間",
            locked: true,
            sortKey: "posted_at",
            render: (row) => (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  {(() => {
                    const badgeStyle = getPostingBadgeStyle(row.postingKind);
                    return (
                      <span
                        style={{
                          display: "inline-block",
                          fontSize: "0.75rem",
                          padding: "1px 6px",
                          borderRadius: 4,
                          fontWeight: 600,
                          background: badgeStyle.background,
                          color: badgeStyle.color,
                        }}
                      >
                        {row.postingKindLabel}
                      </span>
                    );
                  })()}
                  <button
                    type="button"
                    style={{
                      background: "none",
                      border: "none",
                      padding: 0,
                      margin: 0,
                      font: "inherit",
                      fontWeight: 700,
                      color: "#0284c7",
                      textDecoration: "underline",
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                    onClick={() =>
                      setModalTarget({
                        isOpen: true,
                        sourceNo: row.sourceNo,
                        postingId: row.postingId,
                        postingKind: row.postingKind,
                      })
                    }
                    title="點擊查看完整單據明細"
                  >
                    {row.sourceNo}
                  </button>
                </div>
                <span className="table-secondary">
                  {formatTaipeiDateTime(row.postedAt, row.occurredOn)}
                </span>
              </>
            ),
          },
          {
            id: "item",
            label: "品名",
            sortKey: "item_name",
            render: (row) => (
              <>
                <strong>{row.itemName}</strong>
                <span className="table-secondary">{row.itemCode}</span>
              </>
            ),
          },
          {
            id: "size",
            label: "規格",
            sortKey: "size",
            render: (row) => <strong>{row.size || "—"}</strong>,
          },
          {
            id: "hr_delta",
            label: "人資倉增減量",
            sortKey: "hr_delta",
            className: "numeric-cell",
            render: (row) => formatDelta(row.hrDelta, row.unit),
          },
          {
            id: "general_delta",
            label: "總倉增減量",
            sortKey: "general_delta",
            className: "numeric-cell",
            render: (row) => formatDelta(row.generalDelta, row.unit),
          },
          {
            id: "hr_on_hand",
            label: "人資倉剩餘量",
            sortKey: "hr_on_hand",
            className: "numeric-cell",
            render: (row) => (
              <>
                <strong>{row.hrOnHand}</strong>
                <small className="table-secondary" style={{ marginLeft: 4 }}>{row.unit}</small>
              </>
            ),
          },
          {
            id: "general_on_hand",
            label: "總倉剩餘量",
            sortKey: "general_on_hand",
            className: "numeric-cell",
            render: (row) => (
              <>
                <strong>{row.generalOnHand}</strong>
                <small className="table-secondary" style={{ marginLeft: 4 }}>{row.unit}</small>
              </>
            ),
          },
        ] satisfies readonly ManagementCatalogColumn<StockMovementRow, StockMovementSortKey>[]}
      />

      <HrRequestDetailModal
        isOpen={modalTarget.isOpen}
        onClose={() => setModalTarget({ isOpen: false, sourceNo: "" })}
        client={client}
        sourceNo={modalTarget.sourceNo}
        postingId={modalTarget.postingId}
        postingKind={modalTarget.postingKind}
      />
    </section>
  );
}
