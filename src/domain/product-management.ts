export type ProductEntityType = "UNIFORM_ITEMS" | "SUPPLIERS" | "SUPPLIER_ITEMS";

export type ProductCatalogStatus = "ALL" | "ACTIVE" | "INACTIVE";
export type ProductCatalogSortKey = "item_code" | "item_name" | "category" | "supplier";
export type ProductCatalogSortDirection = "asc" | "desc";

export type ProductCatalogEntry = {
  id: string;
  item_code: string;
  item_name: string;
  unit: string;
  size: string | null;
  category: string | null;
  season: string | null;
  is_active: boolean;
  supplierSummary: string[];
};

export type ProductCatalogFilter = {
  query: string;
  category: string;
  status: ProductCatalogStatus;
};

export type ProductEditorForm = {
  itemCode: string;
  itemName: string;
  unit: string;
  size: string;
  category: string;
  season: string;
  supplierCode: string;
  supplierName: string;
  defaultCurrency: string;
  minimumOrderQuantity: string;
  supplierItemCode: string;
  isActive: boolean;
};

export const emptyProductEditorForm: ProductEditorForm = {
  itemCode: "",
  itemName: "",
  unit: "件",
  size: "",
  category: "",
  season: "",
  supplierCode: "",
  supplierName: "",
  defaultCurrency: "TWD",
  minimumOrderQuantity: "",
  supplierItemCode: "",
  isActive: true,
};

function clean(value: string): string {
  return value.trim();
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, "zh-Hant", { numeric: true, sensitivity: "base" });
}

export function productCatalogCategories(rows: readonly ProductCatalogEntry[]): string[] {
  return Array.from(new Set(rows.map((row) => clean(row.category ?? "")).filter(Boolean))).sort(compareText);
}

export function filterProductCatalog(rows: readonly ProductCatalogEntry[], filter: ProductCatalogFilter): ProductCatalogEntry[] {
  const query = clean(filter.query).toLocaleLowerCase("zh-Hant");
  return rows.filter((row) => {
    if (filter.category !== "ALL" && row.category !== filter.category) return false;
    if (filter.status === "ACTIVE" && !row.is_active) return false;
    if (filter.status === "INACTIVE" && row.is_active) return false;
    if (!query) return true;
    const searchable = [
      row.item_code,
      row.item_name,
      row.unit,
      row.size,
      row.category,
      row.season,
      ...row.supplierSummary,
    ].filter(Boolean).join(" ").toLocaleLowerCase("zh-Hant");
    return searchable.includes(query);
  });
}

export function sortProductCatalog(
  rows: readonly ProductCatalogEntry[],
  key: ProductCatalogSortKey,
  direction: ProductCatalogSortDirection,
): ProductCatalogEntry[] {
  const multiplier = direction === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => {
    const leftValue = key === "supplier" ? left.supplierSummary.join(" ") : String(left[key] ?? "");
    const rightValue = key === "supplier" ? right.supplierSummary.join(" ") : String(right[key] ?? "");
    return compareText(leftValue, rightValue) * multiplier;
  });
}

export function productEditorKey(entityType: ProductEntityType, form: ProductEditorForm): string {
  if (entityType === "UNIFORM_ITEMS") return clean(form.itemCode);
  if (entityType === "SUPPLIERS") return clean(form.supplierCode);
  return `${clean(form.supplierCode)}:${clean(form.itemCode)}`;
}

export function productEditorImportRow(entityType: ProductEntityType, form: ProductEditorForm): Record<string, string | boolean> {
  if (entityType === "UNIFORM_ITEMS") {
    return {
      code: clean(form.itemCode),
      name: clean(form.itemName),
      unit: clean(form.unit),
      size: clean(form.size),
      category: clean(form.category),
      season: clean(form.season),
      isActive: form.isActive,
    };
  }
  if (entityType === "SUPPLIERS") {
    return {
      supplierCode: clean(form.supplierCode),
      name: clean(form.supplierName),
      defaultCurrency: clean(form.defaultCurrency).toUpperCase(),
      isActive: form.isActive,
    };
  }
  return {
    supplierCode: clean(form.supplierCode),
    itemCode: clean(form.itemCode),
    minimumOrderQuantity: clean(form.minimumOrderQuantity),
    supplierItemCode: clean(form.supplierItemCode),
    isActive: form.isActive,
  };
}

export function validateProductEditor(entityType: ProductEntityType, form: ProductEditorForm): string | null {
  if (entityType === "UNIFORM_ITEMS") {
    if (!clean(form.itemCode) || !clean(form.itemName) || !clean(form.unit)) return "品號、品名與單位為必填。";
    return null;
  }
  if (entityType === "SUPPLIERS") {
    if (!clean(form.supplierCode) || !clean(form.supplierName)) return "供應商代碼與名稱為必填。";
    return null;
  }
  if (!clean(form.supplierCode) || !clean(form.itemCode)) return "供應商代碼與品號為必填。";
  if (!/^[0-9]+$/.test(clean(form.minimumOrderQuantity))) return "MOQ 必須是 0 或正整數。";
  return null;
}
