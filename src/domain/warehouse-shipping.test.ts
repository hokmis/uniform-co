import { describe, expect, it } from "vitest";
import {
  calculateWarehouseShipment,
  WarehouseShipmentValidationError,
} from "./warehouse-shipping";

describe("warehouse shipment formulas", () => {
  it("deducts HR warehouse directly for issues and general warehouse remains untouched without increases", () => {
    // 階段一：員工領用 2 件，人事倉庫發貨扣庫 -2（10 -> 8），總倉暫時不變（20 -> 20）
    expect(
      calculateWarehouseShipment({
        hrOnHand: 10,
        generalOnHand: 20,
        issueQuantity: 2,
        increaseQuantity: 0,
        otherActiveReserved: 0,
        actualTransfer: 0,
      }),
    ).toEqual({
      requestedTransferQuantity: 0,
      maximumTransferQuantity: 0,
      transferDifference: 0,
      hrOnHandAfter: 8,
      generalOnHandAfter: 20,
      companyOnHandAfter: 28,
    });
  });

  it("transfers from GENERAL only for increases", () => {
    // 階段一：員工領用 5 件，增庫 5 件，調庫 5 件
    // 人事倉：10 - 5 + 5 = 10，總倉：20 - 5 = 15
    expect(
      calculateWarehouseShipment({
        hrOnHand: 10,
        generalOnHand: 20,
        issueQuantity: 5,
        increaseQuantity: 5,
        otherActiveReserved: 0,
        actualTransfer: 5,
      }),
    ).toEqual({
      requestedTransferQuantity: 5,
      maximumTransferQuantity: 5,
      transferDifference: 0,
      hrOnHandAfter: 10,
      generalOnHandAfter: 15,
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
