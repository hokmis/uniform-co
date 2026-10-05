import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { canSubmitCorrection, stocktakeCorrectionPickerOptions, warehouseTransferCorrectionPickerOptions } from "./correction-workflow-selection";
import { filterItemOptions } from "./item-picker";

describe("correction document workflow", () => {
  it("lets users find a transfer correction source by document number or item in one searchable choice", () => {
    const options = warehouseTransferCorrectionPickerOptions([
      { kind: "SHIPMENT" as const, lineId: "shipment-line", parentNo: "SHP-2026-008", itemCode: "SHIRT-M", itemName: "制服上衣", actual: 4, requested: 5 },
      { kind: "REPLENISHMENT" as const, lineId: "replenishment-line", parentNo: "REP-2026-014", itemCode: "PANTS-L", itemName: "制服長褲", actual: 8, requested: 8 },
    ]);

    expect(filterItemOptions(options, "REP-2026-014 PANTS-L")).toEqual([
      { id: "REPLENISHMENT:replenishment-line", code: "PANTS-L", name: "制服長褲", detail: "補庫 REP-2026-014｜原調撥 8／上限 8" },
    ]);
    expect(filterItemOptions(options, "SHIRT-M SHP-2026-008")).toEqual([
      { id: "SHIPMENT:shipment-line", code: "SHIRT-M", name: "制服上衣", detail: "發貨 SHP-2026-008｜原調撥 4／上限 5" },
    ]);
  });

  it.each([
    ["WarehouseTransferCorrectionPanel.tsx", "warehouseTransferCorrectionPickerOptions(sources)", "原始調撥明細"],
    ["StocktakeCorrectionPanel.tsx", "stocktakeCorrectionPickerOptions(sources)", "原始盤點明細"],
  ])("uses one searchable document-and-item source selector in %s", (fileName, optionBuilder, label) => {
    const panel = readFileSync(new URL(`../app/${fileName}`, import.meta.url), "utf8");
    expect(panel).toContain(`options={${optionBuilder}}`);
    expect(panel).toContain(`label=\"${label}\"`);
    expect(panel).not.toContain("documentKey");
    expect(panel).not.toContain("correctionDocumentOptions");
  });

  it("lets users find a stocktake correction source by stocktake number or item in one searchable choice", () => {
    const options = stocktakeCorrectionPickerOptions([
      { lineId: "stocktake-line-1", stocktakeNo: "ST-2026-031", itemCode: "SHIRT-M", itemName: "制服上衣", book: 10, counted: 8 },
      { lineId: "stocktake-line-2", stocktakeNo: "ST-2026-032", itemCode: "PANTS-L", itemName: "制服長褲", book: 4, counted: 7 },
    ]);

    expect(filterItemOptions(options, "ST-2026-032 PANTS-L")).toEqual([
      { id: "stocktake-line-2", code: "PANTS-L", name: "制服長褲", detail: "盤點 ST-2026-032｜帳面 4／實盤 7" },
    ]);
  });

  it("allows an already-created draft to be completed even when its source is not in the current picker snapshot", () => {
    expect(canSubmitCorrection({ status: "DRAFT" }, false, false, false)).toBe(true);
    expect(canSubmitCorrection(null, false, true, true)).toBe(false);
    expect(canSubmitCorrection(null, true, true, true)).toBe(true);
    expect(canSubmitCorrection({ status: "POSTED" }, true, true, true)).toBe(false);
  });

  it("offers status recovery even when no source is selected", () => {
    for (const file of ["WarehouseTransferCorrectionPanel.tsx", "StocktakeCorrectionPanel.tsx"]) {
      const panel = readFileSync(new URL(`../app/${file}`, import.meta.url), "utf8");
      expect(panel).toContain("重新查詢上次更正結果");
      expect(panel).toContain("setRecoveryRetryToken");
      expect(panel).toContain("canSubmitCorrection(");
    }
  });
});
