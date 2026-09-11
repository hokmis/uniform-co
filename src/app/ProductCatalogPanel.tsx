"use client";

import { useEffect, useMemo, useState } from "react";
import {
  filterProductCatalog,
  productCatalogCategories,
  sortProductCatalog,
  type ProductCatalogEntry,
  type ProductCatalogSortDirection,
  type ProductCatalogSortKey,
  type ProductCatalogStatus,
} from "@/src/domain/product-management";
import { getSupabaseBrowserClient } from "@/src/lib/supabase-browser";
import ManagementCatalogTable from "./ManagementCatalogTable";

type ItemSource = Omit<ProductCatalogEntry, "supplierSummary">;
type SupplierSource = { id: string; supplier_code: string; name: string };
type SupplierItemSource = { item_id: string; supplier_id: string; minimum_order_quantity: number | null; supplier_item_code: string | null };

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
};

export default function ProductCatalogPanel({ refreshToken = 0, onEditItem, onDeactivateItem }: Props) {
  const client = getSupabaseBrowserClient();
  const [rows, setRows] = useState<ProductCatalogEntry[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("ALL");
  const [status, setStatus] = useState<ProductCatalogStatus>("ALL");
  const [sortKey, setSortKey] = useState<ProductCatalogSortKey>("item_code");
  const [sortDirection, setSortDirection] = useState<ProductCatalogSortDirection>("asc");
  const [page, setPage] = useState(1);
  const [message, setMessage] = useState(() => client ? "正在讀取商品清單…" : "預覽模式：設定 Supabase env 並登入後，才能讀取受 RLS 保護的商品清單");
  const [busy, setBusy] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!client) return;
    const supabase = client;
    let active = true;
    async function load() {
      setBusy(true);
      const [itemResult, supplierResult, relationResult] = await Promise.all([
        supabase.from("uniform_items").select("id,item_code,item_name,unit,size,category,season,is_active").order("item_code").limit(1000),
        supabase.from("suppliers").select("id,supplier_code,name").eq("is_active", true).order("supplier_code").limit(1000),
        supabase.from("supplier_uniform_items").select("item_id,supplier_id,minimum_order_quantity,supplier_item_code").eq("is_active", true).limit(5000),
      ]);
      if (!active) return;
      if (itemResult.error) {
        setRows([]);
        setMessage(`商品清單載入失敗：${itemResult.error.message}`);
      } else {
        const items = (itemResult.data ?? []) as ItemSource[];
        const suppliers = (supplierResult.data ?? []) as SupplierSource[];
        const relations = (relationResult.data ?? []) as SupplierItemSource[];
        setRows(buildProductRows(items, suppliers, relations));
        setMessage(supplierResult.error || relationResult.error
          ? `已載入 ${items.length} 個品號；目前角色無法讀取完整供應商關係`
          : `已載入 ${items.length} 個品號，資料來自目前 Supabase 主檔`);
      }
      setBusy(false);
    }
    void load();
    return () => { active = false; };
  }, [client, refreshToken, reloadToken]);

  const categories = useMemo(() => productCatalogCategories(rows), [rows]);
  const filteredRows = useMemo(
    () => sortProductCatalog(filterProductCatalog(rows, { query, category, status }), sortKey, sortDirection),
    [category, query, rows, sortDirection, sortKey, status],
  );
  const associatedCount = rows.filter((row) => row.supplierSummary.length > 0).length;

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
    <section className="panel product-catalog-panel" aria-label="商品清單">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">PRODUCT CATALOG</p>
          <h2>商品清單</h2>
          <p className="auth-message">可直接搜尋、分類、排序並從每一列進入編輯或停用；大量異動請使用匯入／匯出。</p>
        </div>
        <div className="product-action-bar">
          <button className="secondary-button" type="button" onClick={() => setReloadToken((value) => value + 1)} disabled={busy}>{busy ? "讀取中…" : "重新整理"}</button>
        </div>
      </div>

      <div className="product-catalog-metrics" aria-label="商品摘要">
        <div className="metric"><span>全部商品</span><strong>{rows.length}</strong><small>目前可讀取品號</small></div>
        <div className="metric"><span>啟用中</span><strong>{rows.filter((row) => row.is_active).length}</strong><small>可供新流程使用</small></div>
        <div className="metric"><span>商品分類</span><strong>{categories.length}</strong><small>依主檔分類統計</small></div>
        <div className="metric"><span>已連結供應商</span><strong>{associatedCount}</strong><small>至少一筆 MOQ 關係</small></div>
      </div>

      <nav className="product-category-tabs" aria-label="商品分類">
        <button className={category === "ALL" ? "active" : ""} type="button" onClick={() => selectCategory("ALL")}>全品項 <span>{rows.length}</span></button>
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
        <p className="muted" role="status">{message}；符合條件 {filteredRows.length} 筆</p>
        {(query || category !== "ALL" || status !== "ALL") ? <button className="text-button product-filter-reset" type="button" onClick={() => { setQuery(""); setCategory("ALL"); setStatus("ALL"); setPage(1); }}>清除篩選</button> : null}
      </div>

      <ManagementCatalogTable<ProductCatalogEntry, ProductCatalogSortKey>
        ariaLabel="商品清單"
        rows={filteredRows}
        rowKey={(row) => row.id}
        page={page}
        onPageChange={setPage}
        sortKey={sortKey}
        sortDirection={sortDirection}
        onSort={toggleSort}
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
          { id: "actions", label: "功能", locked: true, render: (row) => <div className="product-table-actions"><button className="product-row-action" type="button" onClick={() => onEditItem(row)}>編輯</button><button className="product-row-action danger" type="button" onClick={() => onDeactivateItem(row)} disabled={!row.is_active}>{row.is_active ? "停用" : "已停用"}</button></div> },
        ]}
      />
    </section>
  );
}
