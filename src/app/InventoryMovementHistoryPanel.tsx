"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ManagementCatalogTable, { type ManagementCatalogColumn } from "./ManagementCatalogTable";
import {
  aggregateStockMovements,
  filterStockMovements,
  sortStockMovements,
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

export default function InventoryMovementHistoryPanel() {
  const { client, isAuthenticated, accountId, identityError, identityLoading } = useWorkspaceSession();
  const panelActive = usePanelActivity();
  const [rows, setRows] = useState<StockMovementRow[]>([]);
  const [query, setQuery] = useState("");
  const [postingKindFilter, setPostingKindFilter] = useState<StockMovementPostingKind | "ALL">("ALL");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
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
            .in("posting_kind", ["WAREHOUSE_SHIPMENT", "REPLENISHMENT", "CORRECTION"])
            .order("posted_at", { ascending: false })
            .limit(1000),
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
      setMessage(`已載入 ${aggregated.length} 筆進出貨異動紀錄（含待發貨預留、發貨、補庫與發放更正過帳）`);
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
      postingKind: postingKindFilter,
      startDate,
      endDate,
    };
    return filterStockMovements(rows, filter);
  }, [endDate, postingKindFilter, query, rows, startDate]);

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
        即時追蹤依據「新增員工制服需求單（發貨）」、「額外補庫申請（調撥入庫）」與「人資發放更正」造成的兩倉即時庫存異動，包含各品項規格、人資倉與總倉增減量及人資倉與總倉剩餘量。
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
            value={postingKindFilter}
            onChange={(event) => {
              setPostingKindFilter(event.target.value as StockMovementPostingKind | "ALL");
              setPage(1);
            }}
          >
            <option value="ALL">全部單據</option>
            <option value="HR_REQUEST_RESERVATION">需求預留(待發貨)</option>
            <option value="WAREHOUSE_SHIPMENT">員工需求發貨</option>
            <option value="REPLENISHMENT">額外補庫調撥</option>
            <option value="HR_ISSUE_CORRECTION">人資發放更正</option>
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

      <div className="management-catalog-result">
        <p className="muted" role="status">
          {message || "尚未載入"}；符合條件 {sortedRows.length} 筆
        </p>
        {(query || postingKindFilter !== "ALL" || startDate || endDate) ? (
          <button
            className="text-button"
            type="button"
            onClick={() => {
              setQuery("");
              setPostingKindFilter("ALL");
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
                  <span
                    style={{
                      display: "inline-block",
                      fontSize: "0.75rem",
                      padding: "1px 6px",
                      borderRadius: 4,
                      fontWeight: 600,
                      background:
                        row.postingKind === "HR_REQUEST_RESERVATION"
                          ? "#f3e8ff"
                          : row.postingKind === "REPLENISHMENT"
                            ? "#e0f2fe"
                            : row.postingKind === "HR_ISSUE_CORRECTION"
                              ? "#ffedd5"
                              : "#fef3c7",
                      color:
                        row.postingKind === "HR_REQUEST_RESERVATION"
                          ? "#7e22ce"
                          : row.postingKind === "REPLENISHMENT"
                            ? "#0369a1"
                            : row.postingKind === "HR_ISSUE_CORRECTION"
                              ? "#c2410c"
                              : "#92400e",
                    }}
                  >
                    {row.postingKindLabel}
                  </span>
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
