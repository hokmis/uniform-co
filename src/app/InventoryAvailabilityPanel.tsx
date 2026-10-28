"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { hrRequestWorkflowChangedEvent } from "@/src/domain/hr-request-events";
import { inventoryDataChangedEvent } from "@/src/domain/inventory-events";
import {
  filterInventoryAvailability,
  inventoryAvailabilityLoadErrorMessage,
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
import {
  STANDARD_UNIFORM_SIZES,
  extractUniformSize,
  compareUniformItems,
} from "@/src/domain/uniform-size";
import ManagementCatalogTable from "./ManagementCatalogTable";
import { usePanelActivity } from "./RetainedPanelSet";
import { useWorkspaceSession } from "./workspace-session";
import { retrySupabaseQueriesAfterSessionRefresh } from "@/src/lib/supabase-session";
import type { AccountScopedReadOutcome } from "@/src/domain/account-scoped-read";
import { useAccountScopedReadSnapshot } from "./use-account-scoped-read-snapshot";
import ItemShortageModal, { type ItemShortageRow } from "./ItemShortageModal";
import SafetyStockEditModal from "./SafetyStockEditModal";
import {
  loadSafetyStockMap,
  saveSafetyStock,
  getSafetyStockThreshold,
  safetyStockChangedEvent,
  type SafetyStockMap,
} from "@/src/domain/safety-stock";

const EMPTY_INVENTORY_ROWS: InventoryAvailabilityRow[] = [];

function statusTone(status: InventoryAvailabilityStatus): string {
  if (status === "AVAILABLE") return "success";
  if (status === "DATA_ERROR" || status === "OUT_OF_STOCK") return "danger";
  if (status === "GENERAL_OUT_OF_STOCK" || status === "BELOW_SAFETY_STOCK") return "warning";
  return "";
}

type UniformCategoryKey = "ALL" | "照服" | "護士" | "行政" | "廚師" | "工務" | "幼兒園" | "OTHER";
type GenderFilterKey = "ALL" | "MALE" | "FEMALE";
type SeasonFilterKey = "ALL" | "SUMMER" | "WINTER";

function getUniformCategory(itemName: string, itemCode: string): UniformCategoryKey {
  const name = itemName || "";
  const code = itemCode || "";
  if (name.includes("照服") || code.includes("照服")) return "照服";
  if (name.includes("護士") || code.includes("護士")) return "護士";
  if (name.includes("行政") || code.includes("行政")) return "行政";
  if (name.includes("廚師") || code.includes("廚師")) return "廚師";
  if (name.includes("工務") || code.includes("工務")) return "工務";
  if (name.includes("幼兒園") || name.includes("幼") || code.includes("幼")) return "幼兒園";
  return "OTHER";
}

function getUniformGender(itemName: string, size?: string | null): "MALE" | "FEMALE" | "NEUTRAL" {
  const s = size ? size.trim() : "";
  const name = itemName ? itemName.trim() : "";

  const sHasMale = s.includes("男");
  const sHasFemale = s.includes("女");
  if (sHasMale && !sHasFemale) return "MALE";
  if (sHasFemale && !sHasMale) return "FEMALE";

  const nameHasMale = name.includes("男");
  const nameHasFemale = name.includes("女");
  if (nameHasMale && !nameHasFemale) return "MALE";
  if (nameHasFemale && !nameHasMale) return "FEMALE";

  return "NEUTRAL";
}

function getUniformSeason(itemName: string, season?: string | null): "SUMMER" | "WINTER" | "ALL_SEASON" | "NONE" {
  const name = itemName ? itemName.trim() : "";
  const seasonStr = season ? season.trim() : "";
  const hasSummer = name.includes("夏") || seasonStr.includes("夏");
  const hasWinter = name.includes("冬") || seasonStr.includes("冬");

  if (hasSummer && hasWinter) return "ALL_SEASON";
  if (hasSummer) return "SUMMER";
  if (hasWinter) return "WINTER";
  return "NONE";
}

export default function InventoryAvailabilityPanel() {
  const { client, isAuthenticated, accountId, identityError, identityLoading } = useWorkspaceSession();
  const panelActive = usePanelActivity();
  const identityReady = Boolean(client && panelActive && isAuthenticated && accountId && !identityLoading && !identityError);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("ALL");
  const [uniformCategory, setUniformCategory] = useState<UniformCategoryKey>("ALL");
  const [genderFilter, setGenderFilter] = useState<GenderFilterKey>("ALL");
  const [seasonFilter, setSeasonFilter] = useState<SeasonFilterKey>("ALL");
  const [sizeFilter, setSizeFilter] = useState("ALL");
  const [statusFilter, setStatusFilter] = useState<InventoryAvailabilityStatusFilter>("ALL");
  const [sortKey, setSortKey] = useState<InventoryAvailabilitySortKey>("item_code");
  const [sortDirection, setSortDirection] = useState<InventoryAvailabilitySortDirection>("asc");
  const [page, setPage] = useState(1);

  const [safetyStockMap, setSafetyStockMap] = useState<SafetyStockMap>(() => {
    return typeof window !== "undefined" ? loadSafetyStockMap() : {};
  });
  const [editingSafetyStockItem, setEditingSafetyStockItem] = useState<InventoryAvailabilityRow | null>(null);

  useEffect(() => {
    function handleSafetyStockChanged() {
      setSafetyStockMap(loadSafetyStockMap());
    }
    window.addEventListener(safetyStockChangedEvent, handleSafetyStockChanged);
    window.addEventListener("storage", handleSafetyStockChanged);
    return () => {
      window.removeEventListener(safetyStockChangedEvent, handleSafetyStockChanged);
      window.removeEventListener("storage", handleSafetyStockChanged);
    };
  }, []);
  const readInventory = useCallback(async (): Promise<AccountScopedReadOutcome<InventoryAvailabilityRow[]>> => {
    if (!client) {
      return { status: "failure", errors: [], message: "庫存清單尚未連線。請登入後重試。" };
    }
    const readAvailability = () => client
      .from("v_item_availability")
      .select("item_id,item_code,item_name,unit,size,category,season,is_active,hr_on_hand_quantity,general_on_hand_quantity,combined_on_hand_quantity,active_reserved_quantity,available_to_request_quantity")
      .order("item_code")
      .limit(500);
    const [result] = await retrySupabaseQueriesAfterSessionRefresh(client, async () => [await readAvailability()] as const);
    if (result.error) {
      return {
        status: "failure",
        errors: [result.error],
        message: inventoryAvailabilityLoadErrorMessage(result.error),
      };
    }
    const data = (result.data ?? []) as unknown as Array<Record<string, unknown>>;
    return {
      status: "success",
      data: data.map(normalizeInventoryAvailabilityRow),
      message: `已載入 ${data.length} 個品號；數量由 v_item_availability 即時計算`,
    };
  }, [client]);
  const {
    data: visibleRows,
    loading: dataLoading,
    message,
    reload,
  } = useAccountScopedReadSnapshot({
    accountId: accountId ?? null,
    enabled: identityReady,
    refreshKey: 0,
    emptyData: EMPTY_INVENTORY_ROWS,
    resourceLabel: "庫存清單",
    initialMessage: client ? "正在確認登入與角色…" : "預覽模式：設定 Supabase env 並登入後，才能讀取受權限保護的兩倉庫存",
    read: readInventory,
  });

  useEffect(() => {
    if (!client || !panelActive) return;
    const refreshInventory = () => reload();
    window.addEventListener(hrRequestWorkflowChangedEvent, refreshInventory);
    window.addEventListener(inventoryDataChangedEvent, refreshInventory);
    return () => {
      window.removeEventListener(hrRequestWorkflowChangedEvent, refreshInventory);
      window.removeEventListener(inventoryDataChangedEvent, refreshInventory);
    };
  }, [client, panelActive, reload]);

  const displayMessage = identityError ?? message;

  const categories = useMemo(() => inventoryAvailabilityCategories(visibleRows), [visibleRows]);

  const categoryCounts = useMemo(() => {
    const counts: Record<UniformCategoryKey, number> = {
      ALL: visibleRows.length,
      照服: 0,
      護士: 0,
      行政: 0,
      廚師: 0,
      工務: 0,
      幼兒園: 0,
      OTHER: 0,
    };
    for (const row of visibleRows) {
      const cat = getUniformCategory(row.itemName, row.itemCode);
      counts[cat] = (counts[cat] || 0) + 1;
    }
    return counts;
  }, [visibleRows]);

  const categoryTabs = useMemo(() => {
    const base: { key: UniformCategoryKey; label: string }[] = [
      { key: "ALL", label: "全部" },
      { key: "照服", label: "照服" },
      { key: "護士", label: "護士" },
      { key: "行政", label: "行政" },
      { key: "廚師", label: "廚師" },
      { key: "工務", label: "工務" },
      { key: "幼兒園", label: "幼兒園" },
    ];
    if (categoryCounts.OTHER > 0) {
      base.push({ key: "OTHER", label: "其他" });
    }
    return base.map((cat) => ({
      ...cat,
      count: categoryCounts[cat.key] || 0,
    }));
  }, [categoryCounts]);

  const filteredRows = useMemo(() => {
    let rows = filterInventoryAvailability(visibleRows, { query, category, status: statusFilter, safetyStockMap });

    if (uniformCategory !== "ALL") {
      rows = rows.filter((row) => getUniformCategory(row.itemName, row.itemCode) === uniformCategory);
    }

    if (genderFilter !== "ALL") {
      rows = rows.filter((row) => getUniformGender(row.itemName, row.size) === genderFilter);
    }

    if (seasonFilter !== "ALL") {
      rows = rows.filter((row) => {
        const s = getUniformSeason(row.itemName, row.season);
        if (seasonFilter === "SUMMER" && s !== "SUMMER" && s !== "ALL_SEASON") return false;
        if (seasonFilter === "WINTER" && s !== "WINTER" && s !== "ALL_SEASON") return false;
        return true;
      });
    }

    if (sizeFilter !== "ALL") {
      rows = rows.filter((row) => extractUniformSize(row.size, row.itemName) === sizeFilter);
    }

    // 預設依品號排序時，依制服款式與尺寸規則排序（XS -> S -> M -> L -> XL -> 2L -> 3L -> 4L -> 5L -> 6L）
    if (sortKey === "item_code") {
      const factor = sortDirection === "asc" ? 1 : -1;
      return [...rows].sort((a, b) => compareUniformItems(a, b) * factor);
    }

    return sortInventoryAvailability(rows, sortKey, sortDirection, safetyStockMap);
  }, [category, genderFilter, query, safetyStockMap, seasonFilter, sizeFilter, sortDirection, sortKey, statusFilter, uniformCategory, visibleRows]);

  const [showAttentionModal, setShowAttentionModal] = useState(false);

  const availableCount = visibleRows.filter((row) => {
    const threshold = getSafetyStockThreshold(row, safetyStockMap);
    return inventoryAvailabilityStatus(row, threshold) === "AVAILABLE";
  }).length;

  const attentionCount = visibleRows.filter((row) => {
    const threshold = getSafetyStockThreshold(row, safetyStockMap);
    const status = inventoryAvailabilityStatus(row, threshold);
    return ["OUT_OF_STOCK", "GENERAL_OUT_OF_STOCK", "BELOW_SAFETY_STOCK", "DATA_ERROR"].includes(status);
  }).length;

  const attentionRows: ItemShortageRow[] = useMemo(() => {
    return visibleRows
      .filter((row) => {
        const threshold = getSafetyStockThreshold(row, safetyStockMap);
        const status = inventoryAvailabilityStatus(row, threshold);
        return ["OUT_OF_STOCK", "GENERAL_OUT_OF_STOCK", "BELOW_SAFETY_STOCK", "DATA_ERROR"].includes(status);
      })
      .map((row) => {
        const threshold = getSafetyStockThreshold(row, safetyStockMap);
        const status = inventoryAvailabilityStatus(row, threshold);
        return {
          itemId: row.itemId,
          itemCode: row.itemCode,
          itemName: row.itemName,
          unit: row.unit,
          size: row.size,
          category: row.category,
          hrOnHand: row.hrOnHand,
          generalOnHand: row.generalOnHand,
          combinedOnHand: row.combinedOnHand,
          activeReserved: row.activeReserved,
          availableToRequest: row.availableToRequest,
          statusLabel: inventoryAvailabilityStatusLabel(status),
          isDataError: status === "DATA_ERROR",
          isGeneralOutOfStock: status === "GENERAL_OUT_OF_STOCK",
          safetyStock: threshold,
          isBelowSafetyStock: status === "BELOW_SAFETY_STOCK",
        };
      });
  }, [visibleRows, safetyStockMap]);

  function toggleSort(nextKey: InventoryAvailabilitySortKey) {
    if (sortKey === nextKey) setSortDirection((direction) => direction === "asc" ? "desc" : "asc");
    else {
      setSortKey(nextKey);
      setSortDirection("asc");
    }
    setPage(1);
  }

  const hasActiveFilters = Boolean(
    query ||
    category !== "ALL" ||
    statusFilter !== "ALL" ||
    uniformCategory !== "ALL" ||
    genderFilter !== "ALL" ||
    seasonFilter !== "ALL" ||
    sizeFilter !== "ALL"
  );

  function resetFilters() {
    setQuery("");
    setCategory("ALL");
    setStatusFilter("ALL");
    setUniformCategory("ALL");
    setGenderFilter("ALL");
    setSeasonFilter("ALL");
    setSizeFilter("ALL");
    setPage(1);
  }

  return (
    <section className="panel" aria-label="兩倉庫存可用量" aria-busy={dataLoading}>
      <div className="panel-heading">
        <div>
          <p className="eyebrow">INVENTORY MANAGEMENT</p>
          <h2>兩倉庫存與可申請量</h2>
        </div>
        <span className="status-pill">依權限唯讀</span>
      </div>
      <p className="auth-message">分別顯示人資倉、總倉帳面量與品號層級預留。可申請量只在兩倉合計層計算，不推算不存在的逐倉預留。</p>

      <div className="management-catalog-metrics inventory-availability-metrics" aria-label="庫存摘要">
        <div className="metric"><span>可讀取品號</span><strong>{visibleRows.length}</strong><small>目前帳號可見範圍</small></div>
        <div className="metric"><span>可申請品號</span><strong>{availableCount}</strong><small>可申請量大於零</small></div>
        <button
          type="button"
          className="metric"
          onClick={() => setShowAttentionModal(true)}
          title="點擊查看缺貨或資料異常品項清單"
          style={{
            cursor: "pointer",
            textAlign: "left",
            border: attentionCount > 0 ? "1px solid #fecaca" : "1px solid var(--line, #e2e8f0)",
            background: attentionCount > 0 ? "#fff5f5" : "#f5f8f3",
            transition: "all 0.15s ease",
            padding: "16px",
            font: "inherit",
          }}
        >
          <span style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>需注意品號</span>
            <span style={{ fontSize: "11px", color: attentionCount > 0 ? "var(--danger, #dc2626)" : "var(--muted)", fontWeight: 700 }}>點擊查看 🔍</span>
          </span>
          <strong style={{ color: attentionCount > 0 ? "var(--danger, #dc2626)" : "inherit" }}>{attentionCount}</strong>
          <small style={{ color: attentionCount > 0 ? "var(--danger, #dc2626)" : undefined }}>缺貨、低於安全庫存或異常（點擊顯示清單）</small>
        </button>
        <div className="metric"><span>商品分類</span><strong>{categories.length}</strong><small>依目前可讀取主檔統計</small></div>
      </div>

      {/* 制服品項一級分類標籤（比照「新增員工制服需求單」分類頁籤樣式） */}
      <div
        role="tablist"
        aria-label="兩倉庫存品項分類"
        style={{
          display: "flex",
          gap: "6px",
          flexWrap: "wrap",
          marginTop: "16px",
          marginBottom: "12px",
          paddingBottom: "8px",
          borderBottom: "1px solid var(--line, #e5e9ef)",
        }}
      >
        {categoryTabs.map((cat) => {
          const isActive = uniformCategory === cat.key;
          return (
            <button
              key={`inv-cat-${cat.key}`}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => {
                setUniformCategory(cat.key);
                setPage(1);
              }}
              style={{
                padding: "6px 12px",
                borderRadius: "8px",
                border: isActive ? "1px solid var(--accent, #d8744a)" : "1px solid #e2e8f0",
                background: isActive ? "var(--accent, #d8744a)" : "#f8fafc",
                color: isActive ? "#fff" : "#475569",
                fontWeight: isActive ? 700 : 500,
                fontSize: "13px",
                cursor: "pointer",
                transition: "all 0.15s ease",
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
              }}
            >
              <span>{cat.label}</span>
              <span
                style={{
                  fontSize: "11px",
                  padding: "1px 5px",
                  borderRadius: "10px",
                  background: isActive ? "rgba(255, 255, 255, 0.25)" : "#e2e8f0",
                  color: isActive ? "#fff" : "#64748b",
                }}
              >
                {cat.count}
              </span>
            </button>
          );
        })}
      </div>

      {dataLoading ? <p className="sr-only" role="status" aria-live="polite">正在載入兩倉庫存可用量…</p> : null}
      <div className="inventory-toolbar">
        <label className="field">
          搜尋品號／品名
          <input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="例如 U-001 或上衣" />
        </label>

        {/* 性別篩選按鈕群 */}
        <div className="field" style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--muted, #64748b)" }}>性別</span>
          <div style={{ display: "inline-flex", borderRadius: "6px", overflow: "hidden", border: "1px solid #cbd5e1", height: "36px" }}>
            {[
              { key: "ALL", label: "全部" },
              { key: "MALE", label: "男" },
              { key: "FEMALE", label: "女" },
            ].map((g) => {
              const active = genderFilter === g.key;
              return (
                <button
                  key={`inv-gender-${g.key}`}
                  type="button"
                  onClick={() => {
                    setGenderFilter(g.key as GenderFilterKey);
                    setPage(1);
                  }}
                  style={{
                    padding: "0 10px",
                    fontSize: "13px",
                    border: "none",
                    borderRight: "1px solid #cbd5e1",
                    background: active ? "var(--accent, #d8744a)" : "#fff",
                    color: active ? "#fff" : "#334155",
                    fontWeight: active ? 700 : 400,
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {g.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* 季節篩選按鈕群 */}
        <div className="field" style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--muted, #64748b)" }}>季節</span>
          <div style={{ display: "inline-flex", borderRadius: "6px", overflow: "hidden", border: "1px solid #cbd5e1", height: "36px" }}>
            {[
              { key: "ALL", label: "全部" },
              { key: "SUMMER", label: "夏季" },
              { key: "WINTER", label: "冬季" },
            ].map((s) => {
              const active = seasonFilter === s.key;
              return (
                <button
                  key={`inv-season-${s.key}`}
                  type="button"
                  onClick={() => {
                    setSeasonFilter(s.key as SeasonFilterKey);
                    setPage(1);
                  }}
                  style={{
                    padding: "0 10px",
                    fontSize: "13px",
                    border: "none",
                    borderRight: "1px solid #cbd5e1",
                    background: active ? "var(--accent, #d8744a)" : "#fff",
                    color: active ? "#fff" : "#334155",
                    fontWeight: active ? 700 : 400,
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {s.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* 尺寸篩選按鈕群 */}
        <div className="field" style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <span style={{ fontSize: "12px", fontWeight: 600, color: "var(--muted, #64748b)" }}>尺寸</span>
          <div style={{ display: "inline-flex", borderRadius: "6px", overflow: "hidden", border: "1px solid #cbd5e1", height: "36px" }}>
            {[
              { key: "ALL", label: "全部" },
              ...STANDARD_UNIFORM_SIZES.map((sz) => ({ key: sz, label: sz })),
            ].map((s) => {
              const active = sizeFilter === s.key;
              return (
                <button
                  key={`inv-size-${s.key}`}
                  type="button"
                  onClick={() => {
                    setSizeFilter(s.key);
                    setPage(1);
                  }}
                  style={{
                    padding: "0 8px",
                    fontSize: "13px",
                    border: "none",
                    borderRight: "1px solid #cbd5e1",
                    background: active ? "var(--accent, #d8744a)" : "#fff",
                    color: active ? "#fff" : "#334155",
                    fontWeight: active ? 700 : 400,
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {s.label}
                </button>
              );
            })}
          </div>
        </div>

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
            <option value="BELOW_SAFETY_STOCK">低於安全庫存</option>
            <option value="GENERAL_OUT_OF_STOCK">總倉無庫存</option>
            <option value="INACTIVE">已停用</option>
            <option value="DATA_ERROR">資料異常</option>
          </select>
        </label>
        <div className="inventory-toolbar-action">
          <button className="secondary-button" type="button" onClick={reload}>
            {dataLoading ? "讀取中…" : "重新整理"}
          </button>
        </div>
      </div>
      <div className="management-catalog-result">
        <p className="muted" role="status">{displayMessage}；符合條件 {filteredRows.length} 個品號</p>
        {hasActiveFilters ? (
          <button className="text-button product-filter-reset" type="button" onClick={resetFilters}>
            清除篩選
          </button>
        ) : null}
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
        loading={dataLoading && visibleRows.length === 0}
        defaultPageSize={25}
        pageSizeOptions={[10, 25, 50, 100]}
        tableClassName="inventory-availability-table"
        emptyState={<p className="empty-state">尚無符合條件的庫存資料，或目前帳號沒有此報表的讀取權限。</p>}
        columns={[
          {
            id: "item-code",
            label: "品號",
            sortKey: "item_code",
            locked: true,
            render: (row) => (
              <button
                type="button"
                onClick={() => setEditingSafetyStockItem(row)}
                title="點擊設定此品項安全庫存"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "4px",
                  fontWeight: 700,
                  color: "#0369a1",
                  textDecoration: "underline",
                  textUnderlineOffset: "2px",
                  cursor: "pointer",
                  padding: 0,
                  background: "none",
                  border: "none",
                  font: "inherit",
                  textAlign: "left",
                }}
              >
                {row.itemCode || "—"}
              </button>
            ),
          },
          { id: "item-name", label: "品名／規格", sortKey: "item_name", render: (row) => <>{row.itemName || "—"}{row.size ? `／${row.size}` : ""}</> },
          { id: "category", label: "分類／季別", sortKey: "category", render: (row) => [row.category, row.season].filter(Boolean).join("／") || "—" },
          { id: "hr", label: "人資倉", sortKey: "hr_on_hand", render: (row) => `${row.hrOnHand} ${row.unit}` },
          { id: "general", label: "總倉", sortKey: "general_on_hand", render: (row) => `${row.generalOnHand} ${row.unit}` },
          { id: "combined", label: "兩倉合計", sortKey: "combined_on_hand", render: (row) => `${row.combinedOnHand} ${row.unit}` },
          { id: "reserved", label: "有效預留", sortKey: "active_reserved", defaultVisible: false, render: (row) => `${row.activeReserved} ${row.unit}` },
          { id: "available", label: "可申請量", sortKey: "available_to_request", render: (row) => <strong>{row.availableToRequest} {row.unit}</strong> },
          {
            id: "safety-stock",
            label: "安全庫存",
            sortKey: "safety_stock",
            render: (row) => {
              const threshold = getSafetyStockThreshold(row, safetyStockMap);
              return (
                <button
                  type="button"
                  onClick={() => setEditingSafetyStockItem(row)}
                  title="點擊設定或調整此品項安全庫存量"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                    padding: "3px 8px",
                    borderRadius: "6px",
                    fontSize: "12px",
                    cursor: "pointer",
                    border: threshold !== null ? "1px solid #93c5fd" : "1px dashed #cbd5e1",
                    background: threshold !== null ? "#eff6ff" : "#f8fafc",
                    color: threshold !== null ? "#1d4ed8" : "#64748b",
                    fontWeight: threshold !== null ? 700 : 400,
                    transition: "all 0.15s ease",
                  }}
                >
                  {threshold !== null ? (
                    <>
                      <span>{threshold} {row.unit}</span>
                      <span style={{ fontSize: "11px", opacity: 0.8 }}>⚙️</span>
                    </>
                  ) : (
                    <span style={{ color: "#94a3b8" }}>＋設定</span>
                  )}
                </button>
              );
            },
          },
          {
            id: "status",
            label: "狀態",
            sortKey: "status",
            locked: true,
            render: (row) => {
              const threshold = getSafetyStockThreshold(row, safetyStockMap);
              const status = inventoryAvailabilityStatus(row, threshold);
              return (
                <span className={`status-pill ${statusTone(status)}`}>
                  {inventoryAvailabilityStatusLabel(status)}
                </span>
              );
            },
          },
        ]}
      />
      <ItemShortageModal
        isOpen={showAttentionModal}
        onClose={() => setShowAttentionModal(false)}
        title="需注意品號清單（缺貨、低於安全庫存或異常）"
        subtitle="以下品項目前無可申請量、低於設定的安全庫存或庫存資料異常，請確認庫存或進貨補庫"
        items={attentionRows}
        onFilterInTable={() => {
          setShowAttentionModal(false);
          setStatusFilter("OUT_OF_STOCK");
          setPage(1);
          if (typeof document !== "undefined") {
            const tableElem = document.querySelector(".inventory-availability-table");
            if (tableElem) {
              tableElem.scrollIntoView({ behavior: "smooth", block: "start" });
            }
          }
        }}
      />
      <SafetyStockEditModal
        key={editingSafetyStockItem ? (editingSafetyStockItem.itemId || editingSafetyStockItem.itemCode) : "none"}
        isOpen={Boolean(editingSafetyStockItem)}
        item={editingSafetyStockItem}
        currentThreshold={editingSafetyStockItem ? getSafetyStockThreshold(editingSafetyStockItem, safetyStockMap) : null}
        onClose={() => setEditingSafetyStockItem(null)}
        onSave={(newThreshold) => {
          if (!editingSafetyStockItem) return;
          saveSafetyStock(editingSafetyStockItem.itemCode, newThreshold, editingSafetyStockItem.itemId);
          setEditingSafetyStockItem(null);
        }}
      />
    </section>
  );
}
