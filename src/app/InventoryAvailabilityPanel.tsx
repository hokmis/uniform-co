"use client";

import { useEffect, useMemo, useState } from "react";
import { getSupabaseBrowserClient } from "@/src/lib/supabase-browser";
import {
  filterInventoryAvailability,
  inventoryAvailabilityCategories,
  inventoryAvailabilityStatus,
  inventoryAvailabilityStatusLabel,
  normalizeInventoryAvailabilityRow,
  sortInventoryAvailability,
  type InventoryAvailabilityRow,
  type InventoryAvailabilitySortDirection,
  type InventoryAvailabilitySortKey,
  type InventoryAvailabilityStatus,
  type InventoryAvailabilityStatusFilter,
} from "@/src/domain/inventory-availability";
import ManagementCatalogTable from "./ManagementCatalogTable";

function statusTone(status: InventoryAvailabilityStatus): string {
  if (status === "AVAILABLE") return "success";
  if (status === "DATA_ERROR") return "danger";
  return "";
}

export default function InventoryAvailabilityPanel() {
  const client = getSupabaseBrowserClient();
  const [rows, setRows] = useState<InventoryAvailabilityRow[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("ALL");
  const [statusFilter, setStatusFilter] = useState<InventoryAvailabilityStatusFilter>("ALL");
  const [sortKey, setSortKey] = useState<InventoryAvailabilitySortKey>("item_code");
  const [sortDirection, setSortDirection] = useState<InventoryAvailabilitySortDirection>("asc");
  const [page, setPage] = useState(1);
  const [message, setMessage] = useState(() => client ? "正在讀取兩倉庫存…" : "預覽模式：設定 Supabase env 並登入後，才能讀取受 RLS 保護的兩倉庫存");
  const [busy, setBusy] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!client) return;
    const supabase = client;
    let active = true;
    async function load() {
      setBusy(true);
      const result = await supabase
        .from("v_item_availability")
        .select("item_id,item_code,item_name,unit,size,category,season,is_active,hr_on_hand_quantity,general_on_hand_quantity,combined_on_hand_quantity,active_reserved_quantity,available_to_request_quantity")
        .order("item_code")
        .limit(500);
      if (!active) return;
      if (result.error) {
        setRows([]);
        setMessage(`庫存清單載入失敗：${result.error.message}`);
      } else {
        setRows(((result.data ?? []) as Array<Record<string, unknown>>).map(normalizeInventoryAvailabilityRow));
        setMessage(`已載入 ${(result.data ?? []).length} 個品號；數量由 v_item_availability 即時計算`);
      }
      setBusy(false);
    }
    void load();
    return () => {
      active = false;
    };
  }, [client, reloadToken]);

  const categories = useMemo(() => inventoryAvailabilityCategories(rows), [rows]);
  const filteredRows = useMemo(
    () => sortInventoryAvailability(
      filterInventoryAvailability(rows, { query, category, status: statusFilter }),
      sortKey,
      sortDirection,
    ),
    [category, query, rows, sortDirection, sortKey, statusFilter],
  );
  const availableCount = rows.filter((row) => inventoryAvailabilityStatus(row) === "AVAILABLE").length;
  const attentionCount = rows.filter((row) => ["OUT_OF_STOCK", "DATA_ERROR"].includes(inventoryAvailabilityStatus(row))).length;

  function toggleSort(nextKey: InventoryAvailabilitySortKey) {
    if (sortKey === nextKey) setSortDirection((direction) => direction === "asc" ? "desc" : "asc");
    else {
      setSortKey(nextKey);
      setSortDirection("asc");
    }
    setPage(1);
  }

  return (
    <section className="panel" aria-label="兩倉庫存可用量">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">INVENTORY MANAGEMENT</p>
          <h2>兩倉庫存與可申請量</h2>
        </div>
        <span className="status-pill">RLS / READ ONLY</span>
      </div>
      <p className="auth-message">分別顯示人資倉、總倉帳面量與品號層級預留。可申請量只在兩倉合計層計算，不推算不存在的逐倉預留。</p>

      <div className="management-catalog-metrics inventory-availability-metrics" aria-label="庫存摘要">
        <div className="metric"><span>可讀取品號</span><strong>{rows.length}</strong><small>目前帳號 RLS 範圍</small></div>
        <div className="metric"><span>可申請品號</span><strong>{availableCount}</strong><small>可申請量大於零</small></div>
        <div className="metric"><span>需注意品號</span><strong>{attentionCount}</strong><small>缺貨或資料異常</small></div>
        <div className="metric"><span>商品分類</span><strong>{categories.length}</strong><small>依目前可讀取主檔統計</small></div>
      </div>

      <div className="inventory-toolbar">
        <label className="field">
          搜尋品號／品名
          <input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="例如 U-001 或上衣" />
        </label>
        <label className="field">
          商品分類
          <select value={category} onChange={(event) => { setCategory(event.target.value); setPage(1); }}>
            <option value="ALL">全部分類</option>
            {categories.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <label className="field">
          庫存狀態
          <select value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value as InventoryAvailabilityStatusFilter); setPage(1); }}>
            <option value="ALL">全部</option>
            <option value="AVAILABLE">可申請</option>
            <option value="OUT_OF_STOCK">無可申請量</option>
            <option value="INACTIVE">已停用</option>
            <option value="DATA_ERROR">資料異常</option>
          </select>
        </label>
        <div className="inventory-toolbar-action"><button className="secondary-button" type="button" onClick={() => setReloadToken((value) => value + 1)} disabled={busy}>
            {busy ? "讀取中…" : "重新整理"}
          </button></div>
      </div>
      <div className="management-catalog-result">
        <p className="muted" role="status">{message}；符合條件 {filteredRows.length} 個品號</p>
        {(query || category !== "ALL" || statusFilter !== "ALL") ? <button className="text-button product-filter-reset" type="button" onClick={() => { setQuery(""); setCategory("ALL"); setStatusFilter("ALL"); setPage(1); }}>清除篩選</button> : null}
      </div>
      <ManagementCatalogTable<InventoryAvailabilityRow, InventoryAvailabilitySortKey>
        ariaLabel="兩倉庫存可用量"
        rows={filteredRows}
        rowKey={(row) => row.itemId || row.itemCode}
        page={page}
        onPageChange={setPage}
        sortKey={sortKey}
        sortDirection={sortDirection}
        onSort={toggleSort}
        defaultPageSize={25}
        pageSizeOptions={[10, 25, 50, 100]}
        tableClassName="inventory-availability-table"
        emptyState={<p className="empty-state">尚無符合條件的庫存資料，或目前帳號沒有此報表的讀取權限。</p>}
        columns={[
          { id: "item-code", label: "品號", sortKey: "item_code", locked: true, render: (row) => <strong>{row.itemCode || "—"}</strong> },
          { id: "item-name", label: "品名／規格", sortKey: "item_name", render: (row) => <>{row.itemName || "—"}{row.size ? `／${row.size}` : ""}</> },
          { id: "category", label: "分類／季別", sortKey: "category", render: (row) => [row.category, row.season].filter(Boolean).join("／") || "—" },
          { id: "hr", label: "人資倉", sortKey: "hr_on_hand", render: (row) => `${row.hrOnHand} ${row.unit}` },
          { id: "general", label: "總倉", sortKey: "general_on_hand", render: (row) => `${row.generalOnHand} ${row.unit}` },
          { id: "combined", label: "兩倉合計", sortKey: "combined_on_hand", render: (row) => `${row.combinedOnHand} ${row.unit}` },
          { id: "reserved", label: "有效預留", sortKey: "active_reserved", defaultVisible: false, render: (row) => `${row.activeReserved} ${row.unit}` },
          { id: "available", label: "可申請量", sortKey: "available_to_request", render: (row) => <strong>{row.availableToRequest} {row.unit}</strong> },
          { id: "status", label: "狀態", sortKey: "status", locked: true, render: (row) => { const status = inventoryAvailabilityStatus(row); return <span className={`status-pill ${statusTone(status)}`}>{inventoryAvailabilityStatusLabel(status)}</span>; } },
        ]}
      />
    </section>
  );
}
