import { describe, expect, it } from "vitest";
import {
  calculateWarehouseShipment,
  WarehouseShipmentValidationError,
} from "./warehouse-shipping";

describe("warehouse shipment formulas", () => {
  it("transfers from GENERAL for issues and preserves HR on-hand after fulfillment", () => {
    // 標準模式：員工領用 2 件，總倉調撥 2 件
    // 人事倉：10 + 2 - 2 = 10（不變），總倉：20 - 2 = 18（扣除）
    expect(
      calculateWarehouseShipment({
        hrOnHand: 10,
        generalOnHand: 20,
        issueQuantity: 2,
        increaseQuantity: 0,
        otherActiveReserved: 0,
        actualTransfer: 2,
      }),
    ).toEqual({
      requestedTransferQuantity: 2,
      maximumTransferQuantity: 2,
      transferDifference: 0,
      hrOnHandAfter: 10,
      generalOnHandAfter: 18,
      companyOnHandAfter: 28,
    });
  });

  it("transfers from GENERAL for both issues and increases", () => {
    // 標準模式：員工領用 5 件，增庫 5 件，調庫 10 件
    // 人事倉：10 + 10 - 5 = 15，總倉：20 - 10 = 10
    expect(
      calculateWarehouseShipment({
        hrOnHand: 10,
        generalOnHand: 20,
        issueQuantity: 5,
        increaseQuantity: 5,
        otherActiveReserved: 0,
        actualTransfer: 10,
      }),
    ).toEqual({
      requestedTransferQuantity: 10,
      maximumTransferQuantity: 10,
      transferDifference: 0,
      hrOnHandAfter: 15,
      generalOnHandAfter: 10,
      companyOnHandAfter: 25,
    });
  });

  it("limits actual transfer by GENERAL stock and requires a short reason if actual < maximum", () => {
    expect(() =>
      calculateWarehouseShipment({
        hrOnHand: 20,
        generalOnHand: 3,
        issueQuantity: 10,
        increaseQuantity: 5,
        otherActiveReserved: 0,
        actualTransfer: 2,
      }),
    ).toThrow("short_ship_reason");
  });
});
