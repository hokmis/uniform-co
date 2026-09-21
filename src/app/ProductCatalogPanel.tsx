"use client";

import { useCallback, useMemo, useState } from "react";
import {
  filterProductCatalog,
  productCatalogCategories,
  sortProductCatalog,
  type ProductCatalogEntry,
  type ProductCatalogSortDirection,
  type ProductCatalogSortKey,
  type ProductCatalogStatus,
} from "@/src/domain/product-management";
import { invalidateMasterDataCache, loadProductMasterData } from "@/src/lib/master-data-cache";
import type { AccountScopedReadOutcome } from "@/src/domain/account-scoped-read";
import ManagementCatalogTable from "./ManagementCatalogTable";
import { usePanelActivity } from "./RetainedPanelSet";
import { useWorkspaceSession } from "./workspace-session";
import { useAccountScopedReadSnapshot } from "./use-account-scoped-read-snapshot";

type ItemSource = Omit<ProductCatalogEntry, "supplierSummary">;
type SupplierSource = { id: string; supplier_code: string; name: string };
type SupplierItemSource = { item_id: string; supplier_id: string; minimum_order_quantity: number | null; supplier_item_code: string | null };
const EMPTY_PRODUCT_ROWS: ProductCatalogEntry[] = [];

export type ProductItemEditRequest = ItemSource;

function buildProductRows(items: ItemSource[], suppliers: SupplierSource[], relations: SupplierItemSource[]): ProductCatalogEntry[] {
  const supplierById = new Map(suppliers.map((supplier) => [supplier.id, supplier]));
  const relationByItem = new Map<string, SupplierItemSource[]>();
  relations.forEach((relation) => {
    const current = relationByItem.get(relation.item_id) ?? [];
    current.push(relation);
    relationByItem.set(relation.item_id, current);
  });
  return items.map((item) => ({
    ...item,
    supplierSummary: (relationByItem.get(item.id) ?? []).map((relation) => {
      const supplier = supplierById.get(relation.supplier_id);
      const supplierLabel = supplier ? `${supplier.supplier_code} ${supplier.name}` : relation.supplier_id;
      return `${supplierLabel}／MOQ ${relation.minimum_order_quantity ?? "—"}${relation.supplier_item_code ? `／${relation.supplier_item_code}` : ""}`;
    }),
  }));
}

type Props = {
  refreshToken?: number;
  onEditItem: (item: ProductItemEditRequest) => void;
  onDeactivateItem: (item: ProductItemEditRequest) => void;
  onDeleteItem: (item: ProductItemEditRequest) => void;
};

export default function ProductCatalogPanel({ refreshToken = 0, onEditItem, onDeactivateItem, onDeleteItem }: Props) {
  const { client, accountId, identityError, identityLoading, isAuthenticated } = useWorkspaceSession();
  const panelActive = usePanelActivity();
  const identityReady = Boolean(client && panelActive && isAuthenticated && accountId && !identityLoading && !identityError);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("ALL");
  const [status, setStatus] = useState<ProductCatalogStatus>("ALL");
  const [sortKey, setSortKey] = useState<ProductCatalogSortKey>("item_code");
  const [sortDirection, setSortDirection] = useState<ProductCatalogSortDirection>("asc");
  const [page, setPage] = useState(1);
  const readProducts = useCallback(async (): Promise<AccountScopedReadOutcome<ProductCatalogEntry[]>> => {
    if (!client) {
      return { status: "failure", errors: [], message: "商品清單尚未連線。請設定 Supabase 並登入後重試。" };
    }
    const sourceResult = await loadProductMasterData(client);
    const itemError = sourceResult.errors.find((error) => error.resource === "uniform_items");
    if (itemError) {
      return { status: "failure", errors: [itemError], message: "商品清單載入失敗；請重新整理後再試。" };
    }

    const items = sourceResult.items as ItemSource[];
    const suppliers = sourceResult.suppliers
      .filter((supplier) => supplier.is_active)
      .map(({ id, supplier_code, name }) => ({ id, supplier_code, name })) as SupplierSource[];
    const relations = sourceResult.supplierItems
      .map(({ item_id, supplier_id, minimum_order_quantity, supplier_item_code }) => ({ item_id, supplier_id, minimum_order_quantity, supplier_item_code })) as SupplierItemSource[];
    const rows = buildProductRows(items, suppliers, relations);
    return {
      status: "success",
      data: rows,
      message: sourceResult.errors.length > 0
        ? `已載入 ${items.length} 個品號；部分供應關係目前無法讀取`
        : `已載入 ${items.length} 個品號，資料來自目前 Supabase 主檔`,
    };
  }, [client]);
  const {
    data: visibleRows,
    hasCurrentSnapshot: hasCurrentDataSnapshot,
    loading: dataLoading,
    message,
    reload,
  } = useAccountScopedReadSnapshot({
    accountId: accountId ?? null,
    enabled: identityReady,
    refreshKey: refreshToken,
    emptyData: EMPTY_PRODUCT_ROWS,
    resourceLabel: "商品清單",
    initialMessage: client ? "正在確認工作區身份…" : "預覽模式：設定 Supabase env 並登入後，才能讀取目前帳號可見的商品清單",
    read: readProducts,
  });

  const displayMessage = identityError ?? message;

  const categories = useMemo(() => productCatalogCategories(visibleRows), [visibleRows]);
  const filteredRows = useMemo(
    () => sortProductCatalog(filterProductCatalog(visibleRows, { query, category, status }), sortKey, sortDirection),
    [category, query, sortDirection, sortKey, status, visibleRows],
  );
  const associatedCount = visibleRows.filter((row) => row.supplierSummary.length > 0).length;

  function selectCategory(nextCategory: string) {
    setCategory(nextCategory);
    setPage(1);
  }

  function toggleSort(nextKey: ProductCatalogSortKey) {
    if (sortKey === nextKey) {
      setSortDirection((value) => value === "asc" ? "desc" : "asc");
    } else {
      setSortKey(nextKey);
      setSortDirection("asc");
    }
    setPage(1);
  }

  return (
    <section className="panel product-catalog-panel" aria-label="商品清單" aria-busy={dataLoading}>
      <div className="panel-heading">
        <div>
          <p className="eyebrow">PRODUCT CATALOG</p>
          <h2>商品清單</h2>
          <p className="auth-message">可直接搜尋、分類、排序並從每一列進入編輯、停用或刪除；大量異動請使用匯入／匯出。</p>
        </div>
        <div className="product-action-bar">
          <button className="secondary-button" type="button" onClick={() => { if (client) invalidateMasterDataCache(client, "product"); reload(); }}>{dataLoading ? "讀取中…" : "重新整理"}</button>
        </div>
      </div>

      <div className="product-catalog-metrics" aria-label="商品摘要">
        <div className="metric"><span>全部商品</span><strong>{visibleRows.length}</strong><small>目前可讀取品號</small></div>
        <div className="metric"><span>啟用中</span><strong>{visibleRows.filter((row) => row.is_active).length}</strong><small>可供新流程使用</small></div>
        <div className="metric"><span>商品分類</span><strong>{categories.length}</strong><small>依主檔分類統計</small></div>
        <div className="metric"><span>已連結供應商</span><strong>{associatedCount}</strong><small>至少一筆 MOQ 關係</small></div>
      </div>

      <nav className="product-category-tabs" aria-label="商品分類">
        <button className={category === "ALL" ? "active" : ""} type="button" onClick={() => selectCategory("ALL")}>全品項 <span>{visibleRows.length}</span></button>
        {categories.map((value) => <button className={category === value ? "active" : ""} key={value} type="button" onClick={() => selectCategory(value)}>{value}</button>)}
      </nav>

      <div className="product-catalog-filters">
        <label className="field">
          <span>搜尋商品</span>
          <input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="搜尋品號、品名、規格或供應商…" />
        </label>
        <label className="field">
          <span>啟用狀態</span>
          <select value={status} onChange={(event) => { setStatus(event.target.value as ProductCatalogStatus); setPage(1); }}>
            <option value="ALL">全部狀態</option>
            <option value="ACTIVE">啟用</option>
            <option value="INACTIVE">停用</option>
          </select>
        </label>
      </div>

      <div className="product-catalog-result">
        <p className="muted" role="status">{displayMessage}；符合條件 {filteredRows.length} 筆</p>
        {(query || category !== "ALL" || status !== "ALL") ? <button className="text-button product-filter-reset" type="button" onClick={() => { setQuery(""); setCategory("ALL"); setStatus("ALL"); setPage(1); }}>清除篩選</button> : null}
      </div>
      {dataLoading ? <p className="sr-only" role="status" aria-live="polite">正在讀取商品清單與供應關係…</p> : null}

      <ManagementCatalogTable<ProductCatalogEntry, ProductCatalogSortKey>
        ariaLabel="商品清單"
        rows={filteredRows}
        rowKey={(row) => row.id}
        page={page}
        onPageChange={setPage}
        sortKey={sortKey}
        sortDirection={sortDirection}
        onSort={toggleSort}
        loading={dataLoading && visibleRows.length === 0}
        defaultPageSize={20}
        pageSizeOptions={[10, 20, 50, 100]}
        tableClassName="product-catalog-table"
        emptyState={<p className="empty-state">尚無符合條件的商品資料。請調整篩選，或使用「新增商品」建立第一筆資料。</p>}
        columns={[
          { id: "item-code", label: "品號", sortKey: "item_code", locked: true, render: (row) => <strong>{row.item_code || "—"}</strong> },
          { id: "item-name", label: "品名", sortKey: "item_name", render: (row) => row.item_name || "—" },
          { id: "category", label: "分類", sortKey: "category", render: (row) => row.category || "未分類" },
          { id: "specification", label: "規格／季別", render: (row) => [row.size, row.season].filter(Boolean).join("／") || "—" },
          { id: "unit", label: "單位", render: (row) => row.unit || "—" },
          { id: "supplier", label: "供應商／MOQ", sortKey: "supplier", className: "product-supplier-cell", render: (row) => row.supplierSummary.length > 0 ? row.supplierSummary.join("；") : <span className="muted">尚未建立供應關係</span> },
          { id: "status", label: "狀態", render: (row) => <span className={`status-pill ${row.is_active ? "success" : ""}`}>{row.is_active ? "啟用" : "停用"}</span> },
          { id: "actions", label: "功能", locked: true, render: (row) => <div className="product-table-actions"><button className="product-row-action" type="button" onClick={() => onEditItem(row)}>編輯</button><button className="product-row-action" type="button" onClick={() => onDeactivateItem(row)} disabled={!row.is_active}>{row.is_active ? "停用" : "已停用"}</button><button className="product-row-action danger" type="button" onClick={() => onDeleteItem(row)}>刪除</button></div> },
        ]}
      />
    </section>
  );
}
