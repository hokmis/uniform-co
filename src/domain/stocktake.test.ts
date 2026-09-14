import { describe, expect, it } from "vitest";
import { calculateStocktakeDifference, StocktakeValidationError } from "./stocktake";

describe("stocktake fencing", () => {
  it("returns the counted difference when the balance version is current", () => {
    expect(
      calculateStocktakeDifference({
        bookQuantity: 10,
        balanceVersion: 4,
        capturedBalanceVersion: 4,
        countedQuantity: 8,
        activeReserved: 0,
        reason: "盤點短少",
      }),
    ).toBe(-2);
  });

  it("rejects a stale balance version", () => {
    expect(() =>
      calculateStocktakeDifference({
        bookQuantity: 10,
        balanceVersion: 5,
        capturedBalanceVersion: 4,
        countedQuantity: 10,
        activeReserved: 0,
      }),
    ).toThrow("STALE_COUNT");
  });

  it("requires a reason for a non-zero difference", () => {
    expect(() =>
      calculateStocktakeDifference({
        bookQuantity: 10,
        balanceVersion: 4,
        capturedBalanceVersion: 4,
        countedQuantity: 8,
        activeReserved: 0,
      }),
    ).toThrow(StocktakeValidationError);
  });
});
