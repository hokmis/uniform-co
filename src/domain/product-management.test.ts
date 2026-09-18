import { describe, expect, it } from "vitest";
import {
  emptyProductEditorForm,
  filterProductCatalog,
  productCatalogCategories,
  productEditorImportRow,
  productEditorKey,
  sortProductCatalog,
  type ProductCatalogEntry,
  validateProductEditor,
} from "./product-management";

const catalogRows: ProductCatalogEntry[] = [
  { id: "2", item_code: "U-10", item_name: "冬季外套", unit: "件", size: "L", category: "上衣", season: "冬季", gender: "男", style: "工務", is_active: false, supplierSummary: ["S-2 乙供應商／MOQ 20"] },
  { id: "1", item_code: "U-2", item_name: "短袖上衣", unit: "件", size: "M", category: "上衣", season: "夏季", gender: "女", style: "護理", is_active: true, supplierSummary: ["S-1 甲供應商／MOQ 10"] },
  { id: "3", item_code: "U-3", item_name: "工作長褲", unit: "件", size: "L", category: "下身", season: "冬季", gender: "男", style: "行政", is_active: true, supplierSummary: [] },
];

describe("product management editor contract", () => {
  it("builds stable item and supplier-item keys", () => {
    expect(productEditorKey("UNIFORM_ITEMS", { ...emptyProductEditorForm, itemCode: " U-001 " })).toBe("U-001");
    expect(productEditorKey("SUPPLIER_ITEMS", { ...emptyProductEditorForm, supplierCode: " S-1 ", itemCode: " U-001 " })).toBe("S-1:U-001");
  });

  it("builds a master import row without changing the server contract", () => {
    const row = productEditorImportRow("UNIFORM_ITEMS", {
      ...emptyProductEditorForm,
      itemCode: " U-001 ",
      itemName: "短袖上衣",
      size: " M ",
      category: "上衣",
      season: "夏季",
      gender: "女",
      style: "護理",
      isActive: false,
    });
    expect(row).toEqual({
      code: "U-001",
      name: "短袖上衣",
      unit: "件",
      size: "M",
      category: "上衣",
      season: "夏季",
      gender: "女",
      style: "護理",
      isActive: false,
    });
  });

  it("requires the fields enforced by apply_master_import", () => {
    expect(validateProductEditor("UNIFORM_ITEMS", emptyProductEditorForm)).toBe("品號、品名與單位為必填。");
    expect(validateProductEditor("SUPPLIER_ITEMS", { ...emptyProductEditorForm, supplierCode: "S-1", itemCode: "U-1", minimumOrderQuantity: "x" })).toBe("MOQ 必須是 0 或正整數。");
    expect(validateProductEditor("SUPPLIER_ITEMS", { ...emptyProductEditorForm, supplierCode: "S-1", itemCode: "U-1", minimumOrderQuantity: "0" })).toBeNull();
  });

  it("filters the catalog by category, season, gender, style, status and searchable text", () => {
    expect(productCatalogCategories(catalogRows)).toEqual(["上衣", "下身"]);
    expect(filterProductCatalog(catalogRows, { query: "乙供應商", category: "ALL", status: "ALL" }).map((row) => row.item_code)).toEqual(["U-10"]);
    expect(filterProductCatalog(catalogRows, { query: "", category: "上衣", status: "ACTIVE" }).map((row) => row.item_code)).toEqual(["U-2"]);
    expect(filterProductCatalog(catalogRows, { query: "", category: "ALL", season: "冬季", status: "ALL" }).map((row) => row.item_code)).toEqual(["U-10", "U-3"]);
    expect(filterProductCatalog(catalogRows, { query: "", category: "ALL", gender: "女", status: "ALL" }).map((row) => row.item_code)).toEqual(["U-2"]);
    expect(filterProductCatalog(catalogRows, { query: "", category: "ALL", style: "工務", status: "ALL" }).map((row) => row.item_code)).toEqual(["U-10"]);
    expect(filterProductCatalog(catalogRows, { query: "護理", category: "ALL", status: "ALL" }).map((row) => row.item_code)).toEqual(["U-2"]);
  });

  it("sorts item codes using natural numeric order", () => {
    expect(sortProductCatalog(catalogRows, "item_code", "asc").map((row) => row.item_code)).toEqual(["U-2", "U-3", "U-10"]);
  });
});
