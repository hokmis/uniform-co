"use client";

import { useEffect, useMemo, useState } from "react";
import {
  emptyProductEditorForm,
  productEditorImportRow,
  productEditorKey,
  validateProductEditor,
  type ProductEditorForm,
  type ProductEntityType,
} from "@/src/domain/product-management";
import { getSupabaseBrowserClient } from "@/src/lib/supabase-browser";
import type { ProductItemEditRequest } from "./ProductCatalogPanel";

type ItemSource = {
  id: string;
  item_code: string;
  item_name: string;
  unit: string;
  size: string | null;
  category: string | null;
  season: string | null;
  is_active: boolean;
};

type SupplierSource = {
  id: string;
  supplier_code: string;
  name: string;
  default_currency: string | null;
  is_active: boolean;
};

type SupplierItemSource = {
  supplier_code: string;
  item_code: string;
  minimum_order_quantity: number | null;
  supplier_item_code: string | null;
  is_active: boolean;
};

type Sources = {
  items: ItemSource[];
  suppliers: SupplierSource[];
  supplierItems: SupplierItemSource[];
};

const entityOptions: Array<[ProductEntityType, string]> = [
  ["UNIFORM_ITEMS", "制服品號"],
  ["SUPPLIERS", "供應商"],
  ["SUPPLIER_ITEMS", "供應商品號／MOQ"],
];

const emptySources: Sources = { items: [], suppliers: [], supplierItems: [] };

function textValue(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function formForItem(item: ItemSource): ProductEditorForm {
  return {
    ...emptyProductEditorForm,
    itemCode: item.item_code,
    itemName: item.item_name,
    unit: item.unit,
    size: textValue(item.size),
    category: textValue(item.category),
    season: textValue(item.season),
    isActive: item.is_active,
  };
}

function formForSupplier(supplier: SupplierSource): ProductEditorForm {
  return {
    ...emptyProductEditorForm,
    supplierCode: supplier.supplier_code,
    supplierName: supplier.name,
    defaultCurrency: textValue(supplier.default_currency) || "TWD",
    isActive: supplier.is_active,
  };
}

function formForSupplierItem(relation: SupplierItemSource): ProductEditorForm {
  return {
    ...emptyProductEditorForm,
    supplierCode: relation.supplier_code,
    itemCode: relation.item_code,
    minimumOrderQuantity: textValue(relation.minimum_order_quantity),
    supplierItemCode: textValue(relation.supplier_item_code),
    isActive: relation.is_active,
  };
}

type Props = {
  allowedEntityTypes?: readonly ProductEntityType[];
  itemEditRequest?: ProductItemEditRequest | null;
  intent?: "EDIT" | "DEACTIVATE";
  onCancel?: () => void;
  onSaved?: (stableKey: string, isActive: boolean) => void;
};

export default function ProductMasterEditorPanel({
  allowedEntityTypes,
  itemEditRequest,
  intent = "EDIT",
  onCancel,
  onSaved,
}: Props) {
  const client = getSupabaseBrowserClient();
  const visibleEntityOptions = entityOptions.filter(([value]) => !allowedEntityTypes || allowedEntityTypes.includes(value));
  const defaultEntityType = itemEditRequest ? "UNIFORM_ITEMS" : visibleEntityOptions[0]?.[0] ?? "UNIFORM_ITEMS";
  const catalogItemEditor = visibleEntityOptions.length === 1 && defaultEntityType === "UNIFORM_ITEMS";
  const [entityType, setEntityType] = useState<ProductEntityType>(defaultEntityType);
  const [form, setForm] = useState<ProductEditorForm>(() => itemEditRequest ? formForItem(itemEditRequest) : emptyProductEditorForm);
  const [editingKey, setEditingKey] = useState(() => itemEditRequest?.item_code ?? "");
  const [sources, setSources] = useState<Sources>(emptySources);
  const [message, setMessage] = useState(() => intent === "DEACTIVATE" && itemEditRequest
    ? `即將停用 ${itemEditRequest.item_code}；請確認商品資料後按「確認停用」`
    : itemEditRequest
      ? `已載入 ${itemEditRequest.item_code}；現在可以修改品名、單位、規格或啟用狀態`
    : client ? "正在讀取可編輯主檔…" : "預覽模式：設定 Supabase env 並登入後，才能保存商品主檔");
  const [busy, setBusy] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!client) return;
    const supabase = client;
    let active = true;
    async function loadSources() {
      const [itemResult, supplierResult, relationResult] = await Promise.all([
        supabase.from("uniform_items").select("id,item_code,item_name,unit,size,category,season,is_active").order("item_code").limit(1000),
        supabase.from("suppliers").select("id,supplier_code,name,default_currency,is_active").order("supplier_code").limit(1000),
        supabase.from("supplier_uniform_items").select("supplier_id,item_id,minimum_order_quantity,supplier_item_code,is_active").eq("is_active", true).limit(5000),
      ]);
      if (!active) return;
      const items = itemResult.error ? [] : (itemResult.data ?? []) as ItemSource[];
      const suppliers = supplierResult.error ? [] : (supplierResult.data ?? []) as SupplierSource[];
      const supplierById = new Map(suppliers.map((supplier) => [supplier.id, supplier.supplier_code]));
      const itemById = new Map(items.map((item) => [item.id, item.item_code]));
      const supplierItems = relationResult.error ? [] : (relationResult.data ?? []).flatMap((row) => {
        const relation = row as { supplier_id?: unknown; item_id?: unknown; minimum_order_quantity?: unknown; supplier_item_code?: unknown; is_active?: unknown };
        const supplierCode = textValue(supplierById.get(textValue(relation.supplier_id)));
        const itemCode = textValue(itemById.get(textValue(relation.item_id)));
        return supplierCode && itemCode ? [{
          supplier_code: supplierCode,
          item_code: itemCode,
          minimum_order_quantity: relation.minimum_order_quantity == null ? null : Number(relation.minimum_order_quantity),
          supplier_item_code: relation.supplier_item_code == null ? null : String(relation.supplier_item_code),
          is_active: relation.is_active !== false,
        }] : [];
      });
      setSources({ items, suppliers, supplierItems });
      const errors = [itemResult.error, supplierResult.error, relationResult.error].filter(Boolean);
      setMessage(errors.length > 0
        ? `部分主檔無法載入；仍可依權限嘗試保存。${errors[0]?.message ?? ""}`
        : `已載入 ${items.length} 個品號、${suppliers.length} 個供應商與 ${supplierItems.length} 筆供應關係`);
    }
    void loadSources();
    return () => { active = false; };
  }, [client, reloadToken]);

  const existingOptions = useMemo(() => {
    if (entityType === "UNIFORM_ITEMS") return sources.items.map((item) => ({ value: item.item_code, label: `${item.item_code}｜${item.item_name}` }));
    if (entityType === "SUPPLIERS") return sources.suppliers.map((supplier) => ({ value: supplier.supplier_code, label: `${supplier.supplier_code}｜${supplier.name}` }));
    return sources.supplierItems.map((relation) => ({ value: `${relation.supplier_code}:${relation.item_code}`, label: `${relation.supplier_code}｜${relation.item_code}` }));
  }, [entityType, sources]);

  function resetEditor(nextEntityType: ProductEntityType = entityType) {
    setEntityType(nextEntityType);
    setEditingKey("");
    setForm(emptyProductEditorForm);
    setMessage("新增模式：填寫欄位後保存，穩定代碼會作為主檔唯一鍵");
  }

  function selectEntity(nextEntityType: ProductEntityType) {
    resetEditor(nextEntityType);
  }

  function selectExisting(value: string) {
    setEditingKey(value);
    if (!value) {
      setForm(emptyProductEditorForm);
      setMessage("新增模式：填寫欄位後保存");
      return;
    }
    if (entityType === "UNIFORM_ITEMS") {
      const item = sources.items.find((candidate) => candidate.item_code === value);
      if (item) setForm(formForItem(item));
    } else if (entityType === "SUPPLIERS") {
      const supplier = sources.suppliers.find((candidate) => candidate.supplier_code === value);
      if (supplier) setForm(formForSupplier(supplier));
    } else {
      const relation = sources.supplierItems.find((candidate) => `${candidate.supplier_code}:${candidate.item_code}` === value);
      if (relation) setForm(formForSupplierItem(relation));
    }
    setMessage(`已載入 ${value}；穩定代碼在修改模式不可變更，避免誤建立另一筆主檔`);
  }

  function updateField(field: keyof ProductEditorForm, value: string | boolean) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function saveForm(formToSave = form) {
    const validationError = validateProductEditor(entityType, formToSave);
    if (validationError) {
      setMessage(validationError);
      return false;
    }
    if (!client) {
      setMessage("預覽模式：設定 Supabase env 並登入後，才會由 apply_master_import 保存主檔");
      return false;
    }
    setBusy(true);
    const row = productEditorImportRow(entityType, formToSave);
    const stableKey = productEditorKey(entityType, formToSave);
    const { data, error } = await client.rpc("apply_master_import", {
      p_entity_type: entityType,
      p_source_filename: `product-editor-${entityType.toLowerCase()}.json`,
      p_rows: [row],
      p_idempotency_key: `PRODUCT-MASTER-${crypto.randomUUID()}`,
      p_request_fingerprint: JSON.stringify({ entityType, stableKey, row }),
    });
    setBusy(false);
    if (error) {
      setMessage(`保存失敗或結果未知：${error.message}；請使用相同資料重試，不要重複建立另一筆`);
      return false;
    }
    const result = data as { status?: string; error_message?: string | null } | null;
    if (result?.status === "FAILED") {
      setMessage(`保存被伺服器拒絕：${result.error_message ?? "請查看批次錯誤"}`);
      return false;
    }
    setReloadToken((value) => value + 1);
    if (!formToSave.isActive) {
      setMessage(`停用 ${stableKey} 完成；已留下主檔異動紀錄，既有交易仍可追溯`);
      if (onSaved) onSaved(stableKey, false);
      else resetEditor();
    } else {
      setEditingKey(stableKey);
      setMessage(`${editingKey ? "修改" : "新增"} ${stableKey} 完成；已留下主檔異動紀錄`);
      onSaved?.(stableKey, true);
    }
    return true;
  }

  async function deactivate() {
    if (!editingKey) {
      setMessage("請先從現有資料載入要刪除的主檔；正式刪除會以停用保存交易歷史");
      return;
    }
    await saveForm({ ...form, isActive: false });
  }

  const keyLocked = Boolean(editingKey);
  const confirmationOnly = intent === "DEACTIVATE";
  const entityLabel = entityOptions.find(([value]) => value === entityType)?.[1] ?? "商品主檔";
  const editorTitle = catalogItemEditor
    ? editingKey ? `編輯商品｜${editingKey}` : "新增商品"
    : "供應商與 MOQ 維護";

  return (
    <section className="panel" id="product-master-editor" aria-label="商品主檔新增修改停用">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">{catalogItemEditor ? "PRODUCT FORM" : "SUPPLIER DIRECTORY"}</p>
          <h2>{editorTitle}</h2>
          <p className="auth-message">{catalogItemEditor
            ? "商品編號建立後不可修改；其餘欄位可直接更新。"
            : "先選擇供應商或供應商品號關係，再載入既有資料修改；也可直接新增一筆。"}</p>
        </div>
        <span className={`status-pill ${intent === "DEACTIVATE" ? "danger" : editingKey ? "success" : ""}`}>{intent === "DEACTIVATE" ? "停用確認" : editingKey ? "修改模式" : "新增模式"}</span>
      </div>
      {intent === "DEACTIVATE" ? <div className="product-deactivate-warning"><strong>停用後不會刪除歷史資料</strong><span>此商品將不再提供新需求或新交易選用；既有庫存、採購與發放紀錄仍可追溯。</span></div> : null}
      {!catalogItemEditor ? <div className="form-grid product-editor-toolbar">
        <label className="field"><span>資料類型</span><select value={entityType} onChange={(event) => selectEntity(event.target.value as ProductEntityType)} disabled={busy}>{visibleEntityOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="field"><span>載入既有資料（修改／停用）</span><select value={editingKey} onChange={(event) => selectExisting(event.target.value)} disabled={busy}><option value="">新增一筆 {entityLabel}</option>{existingOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      </div> : null}
      {entityType === "UNIFORM_ITEMS" ? <div className="form-grid">
        <label className="field"><span>品號</span><input value={form.itemCode} onChange={(event) => updateField("itemCode", event.target.value)} disabled={busy || keyLocked || confirmationOnly} maxLength={100} /></label>
        <label className="field"><span>品名</span><input value={form.itemName} onChange={(event) => updateField("itemName", event.target.value)} disabled={busy || confirmationOnly} maxLength={255} /></label>
        <label className="field"><span>單位</span><input value={form.unit} onChange={(event) => updateField("unit", event.target.value)} disabled={busy || confirmationOnly} maxLength={40} /></label>
        <label className="field"><span>尺寸（選填）</span><input value={form.size} onChange={(event) => updateField("size", event.target.value)} disabled={busy || confirmationOnly} maxLength={80} /></label>
        <label className="field"><span>分類（選填）</span><input value={form.category} onChange={(event) => updateField("category", event.target.value)} disabled={busy || confirmationOnly} maxLength={80} /></label>
        <label className="field"><span>季別（選填）</span><input value={form.season} onChange={(event) => updateField("season", event.target.value)} disabled={busy || confirmationOnly} maxLength={80} /></label>
      </div> : null}
      {entityType === "SUPPLIERS" ? <div className="form-grid">
        <label className="field"><span>供應商代碼</span><input value={form.supplierCode} onChange={(event) => updateField("supplierCode", event.target.value)} disabled={busy || keyLocked} maxLength={100} /></label>
        <label className="field"><span>供應商名稱</span><input value={form.supplierName} onChange={(event) => updateField("supplierName", event.target.value)} disabled={busy} maxLength={255} /></label>
        <label className="field"><span>預設幣別（選填）</span><input value={form.defaultCurrency} onChange={(event) => updateField("defaultCurrency", event.target.value)} disabled={busy} maxLength={3} /></label>
      </div> : null}
      {entityType === "SUPPLIER_ITEMS" ? <div className="form-grid">
        <label className="field"><span>供應商</span><select value={form.supplierCode} onChange={(event) => updateField("supplierCode", event.target.value)} disabled={busy || keyLocked}><option value="">請選擇</option>{sources.suppliers.filter((supplier) => supplier.is_active).map((supplier) => <option key={supplier.id} value={supplier.supplier_code}>{supplier.supplier_code}｜{supplier.name}</option>)}</select></label>
        <label className="field"><span>制服品號</span><select value={form.itemCode} onChange={(event) => updateField("itemCode", event.target.value)} disabled={busy || keyLocked}><option value="">請選擇</option>{sources.items.filter((item) => item.is_active).map((item) => <option key={item.id} value={item.item_code}>{item.item_code}｜{item.item_name}</option>)}</select></label>
        <label className="field"><span>MOQ</span><input type="number" min={0} step={1} value={form.minimumOrderQuantity} onChange={(event) => updateField("minimumOrderQuantity", event.target.value)} disabled={busy} /></label>
        <label className="field"><span>供應商品號（選填）</span><input value={form.supplierItemCode} onChange={(event) => updateField("supplierItemCode", event.target.value)} disabled={busy} maxLength={100} /></label>
      </div> : null}
      {!confirmationOnly ? <label className="checkbox-field"><input type="checkbox" checked={form.isActive} onChange={(event) => updateField("isActive", event.target.checked)} disabled={busy} />啟用此主檔</label> : null}
      <div className="button-row">
        {intent === "DEACTIVATE"
          ? <button className="danger-button" type="button" onClick={() => void deactivate()} disabled={busy || !editingKey}>{busy ? "停用中…" : "確認停用"}</button>
          : <button className="primary-button" type="button" onClick={() => void saveForm()} disabled={busy}>{busy ? "保存中…" : editingKey ? "儲存修改" : "新增主檔"}</button>}
        {intent !== "DEACTIVATE" && !catalogItemEditor ? <button className="secondary-button" type="button" onClick={() => void deactivate()} disabled={busy || !editingKey}>停用／刪除</button> : null}
        {intent !== "DEACTIVATE" && !catalogItemEditor ? <button className="secondary-button" type="button" onClick={() => resetEditor()} disabled={busy}>清除並新增</button> : null}
        {!catalogItemEditor ? <button className="secondary-button" type="button" onClick={() => setReloadToken((value) => value + 1)} disabled={busy}>重新整理既有資料</button> : null}
        {onCancel ? <button className="secondary-button" type="button" onClick={onCancel} disabled={busy}>取消並返回列表</button> : null}
      </div>
      <p className={message.includes("失敗") || message.includes("拒絕") ? "auth-message" : "success-note"} role="status">{message}</p>
    </section>
  );
}
