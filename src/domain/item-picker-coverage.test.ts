import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("searchable item picker adoption", () => {
  it("allows users to clear a mistaken single-item choice and reset multi-selection", () => {
    const source = readFileSync(resolve(process.cwd(), "src/app/SearchableItemPicker.tsx"), "utf8");

    expect(source).toContain(">清除選取</button>");
    expect(source).toContain(">清除已選</button>");
    expect(source).toContain("clearItemPickerSelection(false)");
    expect(source).toContain("clearItemPickerSelection(true)");
  });

  it("shows selected multi-items with per-item removal and an expandable summary", () => {
    const source = readFileSync(resolve(process.cwd(), "src/app/SearchableItemPicker.tsx"), "utf8");

    expect(source).toContain("selectedItemsPreview(options, selectedIds");
    expect(source).toContain('aria-label={`${label}已選${entityNoun}`}');
    expect(source).toContain('entityNoun = "品號"');
    expect(source).toContain('entityCounter = "個"');
    expect(source).toContain("selectedItemsPreview(options, selectedIds, showAllSelected ? selectedIds.length : 5)");
    expect(source).toContain("toggleItemSelection(selectedIds, item.id)");
    expect(source).toContain("查看另外 {entityCount(selectedPreview.hiddenCount)}");
  });

  it("offers an explicit size filter and applies it to the visible option list", () => {
    const source = readFileSync(resolve(process.cwd(), "src/app/SearchableItemPicker.tsx"), "utf8");

    expect(source).toContain("sizeOptions.length > 1");
    expect(source).toContain("尺寸篩選");
    expect(source).toContain("filterItemOptions(options, query, 100, { size: activeSizeFilter })");
    expect(source).toContain("selectVisibleItemOptions(selectedIds, visibleOptions.map((option) => option.id))");
  });

  it("lets keyboard users dismiss the open picker from any child and returns focus to its trigger", () => {
    const source = readFileSync(resolve(process.cwd(), "src/app/SearchableItemPicker.tsx"), "utf8");

    expect(source).toContain('role="dialog" aria-label={`${label}選擇器`}');
    expect(source).toContain("onKeyDown={handlePopoverKeyDown}");
    expect(source).toContain("shouldDismissItemPicker(event.key, disabled)");
    expect(source).toContain("close(true)");
    expect(source).toContain("triggerRef.current?.focus()");
  });

  it("does not leave picker controls operable after the owning workflow becomes disabled", () => {
    const source = readFileSync(resolve(process.cwd(), "src/app/SearchableItemPicker.tsx"), "utf8");

    expect(source).toContain("if (previousDisabled !== disabled)");
    expect(source).toContain("if (disabled) {");
    expect(source).toContain("aria-busy={disabled}");
    expect(source.match(/disabled=\{disabled\}/g)?.length).toBeGreaterThanOrEqual(8);
  });

  it.each([
    "HrRequestWorkbench.tsx",
    "ReplenishmentPanel.tsx",
    "StocktakePanel.tsx",
    "InventoryMovementHistoryPanel.tsx",
    "InventoryHistoryExportPanel.tsx",
    "SeasonalCampaignPanel.tsx",
    "SeasonalDemandPanel.tsx",
    "SeasonalProcurementPanel.tsx",
    "ProductMasterEditorPanel.tsx",
    "PurchaseReceiptPanel.tsx",
    "WarehouseTransferCorrectionPanel.tsx",
    "StocktakeCorrectionPanel.tsx",
    "HrIssueCorrectionPanel.tsx",
    "ReturnPanel.tsx",
    "ReturnCorrectionPanel.tsx",
    "PurchaseReceiptCorrectionPanel.tsx",
  ])("uses the shared searchable item picker in %s", (fileName) => {
    const source = readFileSync(resolve(process.cwd(), "src/app", fileName), "utf8");
    expect(source).toContain("SearchableItemPicker");
  });

  it("lets inventory exports optionally filter by several searched uniform items", () => {
    const source = readFileSync(resolve(process.cwd(), "src/app/InventoryHistoryExportPanel.tsx"), "utf8");

    expect(source).toContain('SearchableItemPicker label="匯出品號"');
    expect(source).toContain("value={exportItemIds} multiple");
    expect(source).toContain('query.in("item_id", exportItemIds)');
    expect(source).toContain("未選取時匯出全部可見品號");
  });

  it("lets stocktake select and add several searched items in one action", () => {
    const source = readFileSync(resolve(process.cwd(), "src/app/StocktakePanel.tsx"), "utf8");

    expect(source).toContain("appendStocktakeItems");
    expect(source).toContain("value={selectedItemIds} multiple");
    expect(source).toContain("加入 ${selectedItemIds.length} 個品號");
  });

  it("lets HR add several searched replenishment items without duplicating existing lines", () => {
    const source = readFileSync(resolve(process.cwd(), "src/app/ReplenishmentPanel.tsx"), "utf8");

    expect(source).toContain("appendReplenishmentItems");
    expect(source).toContain("<span>批次加入品號（可搜尋複選）</span>");
    expect(source).toContain("value={selectedItemIds} multiple");
    expect(source).toContain("加入所選 {selectedItemIds.length} 個品號");
    expect(source).toContain("const selectableItems = visibleItems.filter((item) => !visibleLines.some((line) => line.itemId === item.id))");
  });

  it("searches existing uniform items and supplier-item relations in the product editor", () => {
    const source = readFileSync(resolve(process.cwd(), "src/app/ProductMasterEditorPanel.tsx"), "utf8");

    expect(source).toContain("const existingItemOptions = useMemo(() => {");
    expect(source).toContain("options={existingItemOptions}");
    expect(source).toContain('detail: item.is_active ? "啟用中" : "已停用"');
    expect(source).toContain("id: `${relation.supplier_code}:${relation.item_code}`");
    expect(source).toContain('onChange={(value) => { if (typeof value === "string") selectExisting(value); }}');
  });

  it.each([
    ["ReturnCorrectionPanel.tsx", "原始退回明細", "return_no", "employee_no_snapshot"],
    ["PurchaseReceiptCorrectionPanel.tsx", "原始入庫明細", "receipt_no", "delivered_quantity"],
  ])("keeps source-document context searchable for %s", (fileName, label, documentField, detailField) => {
    const source = readFileSync(resolve(process.cwd(), "src/app", fileName), "utf8");
    expect(source).toContain(`label=\"${label}\"`);
    expect(source).toContain(`line.${documentField}`);
    expect(source).toContain(`line.${detailField}`);
    expect(source).toContain("onChange={(value) => { if (typeof value === \"string\") chooseLine(value); }}");
  });

  it("shows the approved quantity in the searchable procurement item picker", () => {
    const source = readFileSync(resolve(process.cwd(), "src/app", "SeasonalProcurementPanel.tsx"), "utf8");

    expect(source).toContain('label="CEO 核准品項"');
    expect(source).toContain("detail: `核准 ${line.approved_quantity}`");
    expect(source).toContain("value={lineId}");
  });
});
