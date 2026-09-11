import { describe, expect, it } from "vitest";
import { validateStocktakeCorrectionInput } from "./stocktake-correction";

describe("validateStocktakeCorrectionInput", () => {
  it("requires a signed integer and reason", () => {
    expect(validateStocktakeCorrectionInput({ countedQuantityDelta: 0, reason: "複盤" })).toContain("非零");
    expect(validateStocktakeCorrectionInput({ countedQuantityDelta: 1, reason: " " })).toContain("原因");
  });
  it("accepts a bounded count correction", () => {
    expect(validateStocktakeCorrectionInput({ countedQuantityDelta: -1, reason: "複盤沖回" })).toBeNull();
  });
});
