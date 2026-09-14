import { describe, expect, it } from "vitest";
import {
  calculateWarehouseShipment,
  WarehouseShipmentValidationError,
} from "./warehouse-shipping";

describe("warehouse shipment formulas", () => {
  it("moves stock from GENERAL and issues from HR without changing increase stock", () => {
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

  it("limits actual transfer by GENERAL stock and requires a short reason", () => {
    expect(() =>
      calculateWarehouseShipment({
        hrOnHand: 20,
        generalOnHand: 3,
        issueQuantity: 10,
        increaseQuantity: 0,
        otherActiveReserved: 0,
        actualTransfer: 2,
      }),
    ).toThrow("short_ship_reason");
  });

  it("rejects a shipment that would uncover another active reservation", () => {
    expect(() =>
      calculateWarehouseShipment({
        hrOnHand: 0,
        generalOnHand: 10,
        issueQuantity: 8,
        increaseQuantity: 0,
        otherActiveReserved: 3,
        actualTransfer: 8,
      }),
    ).toThrow(WarehouseShipmentValidationError);
  });
});
