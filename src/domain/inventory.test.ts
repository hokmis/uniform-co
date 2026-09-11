import { describe, expect, it } from "vitest";
import {
  calculateRequestSummary,
  calculateWarehousePost,
  InventoryRuleError,
} from "./inventory";

describe("uniform inventory request seam", () => {
  it("accepts issue plus increase only within combined available stock", () => {
    expect(
      calculateRequestSummary({
        hrOnHand: 10,
        generalOnHand: 5,
        activeReserved: 0,
        issueQuantity: 10,
        increaseQuantity: 5,
      }),
    ).toMatchObject({
      requestedTransfer: 15,
      availableToRequest: 15,
      canSubmit: true,
    });
  });

  it("rejects a request that would exceed the two-warehouse total", () => {
    expect(() =>
      calculateRequestSummary({
        hrOnHand: 10,
        generalOnHand: 5,
        activeReserved: 0,
        issueQuantity: 15,
        increaseQuantity: 1,
      }),
    ).toThrowError(InventoryRuleError);
  });

  it("uses general stock as the warehouse transfer ceiling and preserves company totals", () => {
    const result = calculateWarehousePost({
      hrOnHand: 5,
      generalOnHand: 100,
      activeReserved: 0,
      issueQuantity: 10,
      increaseQuantity: 0,
      actualTransfer: 10,
    });

    expect(result).toEqual({
      requestedTransfer: 10,
      maximumTransfer: 10,
      transferDifference: 0,
      hrOnHandAfter: 5,
      generalOnHandAfter: 90,
      companyOnHandDelta: -10,
      shortShipReasonRequired: false,
    });
  });

  it("requires a reason for a deliberate short shipment", () => {
    expect(() =>
      calculateWarehousePost({
        hrOnHand: 20,
        generalOnHand: 3,
        activeReserved: 0,
        issueQuantity: 10,
        increaseQuantity: 0,
        actualTransfer: 2,
      }),
    ).toThrow("short_ship_reason");
  });
});
