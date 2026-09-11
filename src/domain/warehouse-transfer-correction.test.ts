import { describe, expect, it } from "vitest";
import { validateWarehouseTransferCorrectionInput } from "./warehouse-transfer-correction";

describe("validateWarehouseTransferCorrectionInput", () => {
  it("requires a signed integer and reason", () => {
    expect(validateWarehouseTransferCorrectionInput({ transferQuantityDelta: 0, reason: "調整" })).toContain("非零");
    expect(validateWarehouseTransferCorrectionInput({ transferQuantityDelta: 1, reason: " " })).toContain("原因");
  });
  it("accepts a bounded correction", () => {
    expect(validateWarehouseTransferCorrectionInput({ transferQuantityDelta: -1, reason: "更正實際調撥" })).toBeNull();
  });
});
