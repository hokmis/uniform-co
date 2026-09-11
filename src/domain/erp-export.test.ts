import { describe, expect, it } from "vitest";
import { ErpExportValidationError, groupErpSourceLines, renderUniformErpCsv } from "./erp-export";

const source = {
  distributionDate: "2026-08-12",
  institutionId: "inst-a",
  institutionCode: "A01",
  institutionName: "A機構",
};

describe("ERP export grouping", () => {
  it("groups shipped issue lines by item and keeps source traceability", () => {
    expect(
      groupErpSourceLines(
        [
          { ...source, sourceId: "l1", itemId: "shirt", itemCode: "U001", itemName: "上衣", unit: "件", quantity: 2 },
          { ...source, sourceId: "l2", itemId: "shirt", itemCode: "U001", itemName: "上衣", unit: "件", quantity: 3 },
        ],
        source.distributionDate,
        source.institutionId,
      ),
    ).toEqual([
      { itemId: "shirt", itemCode: "U001", itemName: "上衣", unit: "件", quantity: 5, sourceIds: ["l1", "l2"] },
    ]);
  });

  it("rejects mixed date/institution or non-positive sources", () => {
    expect(() =>
      groupErpSourceLines(
        [{ ...source, sourceId: "l1", itemId: "shirt", itemCode: "U001", itemName: "上衣", unit: "件", quantity: 0 }],
        source.distributionDate,
        source.institutionId,
      ),
    ).toThrow(ErpExportValidationError);
  });

  it("requires a validated Dingxin mapping before rendering", () => {
    const lines = [{ itemId: "shirt", itemCode: "U001", itemName: "上衣", unit: "件", quantity: 5, sourceIds: ["l1"] }];
    expect(() => renderUniformErpCsv(lines, "DINGXIN-UNKNOWN")).toThrow(/validated sample/);
    expect(renderUniformErpCsv(lines, "UNIFORM-ERP-SALES-v0")).toContain('"U001"');
  });
});
