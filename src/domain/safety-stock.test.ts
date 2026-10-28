import { describe, expect, it, beforeEach } from "vitest";
import {
  getSafetyStockThreshold,
  isBelowSafetyStock,
  loadSafetyStockMap,
  saveSafetyStock,
  SAFETY_STOCK_STORAGE_KEY,
} from "./safety-stock";

describe("safety-stock domain", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("handles empty or invalid localStorage gracefully", () => {
    expect(loadSafetyStockMap()).toEqual({});

    localStorage.setItem(SAFETY_STOCK_STORAGE_KEY, "invalid-json");
    expect(loadSafetyStockMap()).toEqual({});
  });

  it("saves and loads safety stock settings", () => {
    saveSafetyStock("U-001", 10);
    saveSafetyStock("U-002", 25);

    const map = loadSafetyStockMap();
    expect(map["U-001"]).toBe(10);
    expect(map["U-002"]).toBe(25);

    // 清除設定（傳入 null 或 0）
    saveSafetyStock("U-001", null);
    expect(loadSafetyStockMap()["U-001"]).toBeUndefined();
  });

  it("gets safety stock threshold matching itemId then itemCode", () => {
    const map = { "item-123": 15, "U-999": 20 };

    expect(getSafetyStockThreshold({ itemId: "item-123", itemCode: "U-123" }, map)).toBe(15);
    expect(getSafetyStockThreshold({ itemId: "item-none", itemCode: "U-999" }, map)).toBe(20);
    expect(getSafetyStockThreshold({ itemId: "unknown", itemCode: "unknown" }, map)).toBeNull();
  });

  it("correctly identifies whether quantity is below safety stock", () => {
    expect(isBelowSafetyStock(10, 15)).toBe(true);
    expect(isBelowSafetyStock(15, 15)).toBe(true);
    expect(isBelowSafetyStock(16, 15)).toBe(false);
    expect(isBelowSafetyStock(0, null)).toBe(false);
    expect(isBelowSafetyStock(5, 0)).toBe(false);
  });
});
