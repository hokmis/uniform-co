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
import { usePanelActivity } from "./RetainedPanelSet";
import { useWorkspaceSession } from "./workspace-session";

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
            .in("posting_kind", ["WAREHOUSE_SHIPMENT", "REPLENISHMENT"])
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
      setMessage(`已載入 ${aggregated.length} 筆進出貨異動紀錄（含待發貨預留、發貨與補庫過帳）`);
    } catch (err) {
      setMessage(`讀取進出貨紀錄異常：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
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
        即時追蹤依據「新增員工制服需求單（發貨）」與「額外補庫申請（調撥入庫）」造成的兩倉即時庫存異動，包含各品項規格、人資倉與總倉增減量及人資倉與總倉剩餘量。
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
        <div className="inventory-toolbar-action">
          <button className="secondary-button" type="button" onClick={() => void loadData()}>
            {loading ? "讀取中…" : "重新整理"}
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
                            : "#fef3c7",
                      color:
                        row.postingKind === "HR_REQUEST_RESERVATION"
                          ? "#7e22ce"
                          : row.postingKind === "REPLENISHMENT"
                            ? "#0369a1"
                            : "#92400e",
                    }}
                  >
                    {row.postingKindLabel}
                  </span>
                  <strong>{row.sourceNo}</strong>
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
    </section>
  );
}
