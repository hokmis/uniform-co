import { describe, expect, it } from "vitest";
import {
  filterInventoryAvailability,
  inventoryAvailabilityStatus,
  inventoryAvailabilityCategories,
  inventoryAvailabilityStatusLabel,
  normalizeInventoryAvailabilityRow,
  sortInventoryAvailability,
} from "./inventory-availability";

describe("inventory availability", () => {
  it("normalizes the read-only availability view without creating a second quantity source", () => {
    const row = normalizeInventoryAvailabilityRow({
      item_id: "item-1",
      item_code: "U-001",
      item_name: "夏季上衣",
      unit: "件",
      size: "M",
      category: "上衣",
      season: "夏",
      is_active: true,
      hr_on_hand_quantity: "5",
      general_on_hand_quantity: 15,
      combined_on_hand_quantity: "20",
      active_reserved_quantity: "3",
      available_to_request_quantity: "17",
    });

    expect(row).toMatchObject({ itemCode: "U-001", hrOnHand: 5, generalOnHand: 15, combinedOnHand: 20, activeReserved: 3, availableToRequest: 17 });
    expect(inventoryAvailabilityStatus(row)).toBe("AVAILABLE");
  });

  it("marks zero availability and inactive items explicitly", () => {
    const out = normalizeInventoryAvailabilityRow({ is_active: true, available_to_request_quantity: 0 });
    const inactive = normalizeInventoryAvailabilityRow({ is_active: false, available_to_request_quantity: 100 });

    expect(inventoryAvailabilityStatus(out)).toBe("OUT_OF_STOCK");
    expect(inventoryAvailabilityStatus(inactive)).toBe("INACTIVE");
    expect(inventoryAvailabilityStatusLabel("OUT_OF_STOCK")).toBe("無可申請量");
  });

  it("surfaces impossible negative values as a data error", () => {
    const row = normalizeInventoryAvailabilityRow({ is_active: true, available_to_request_quantity: -1 });
    expect(inventoryAvailabilityStatus(row)).toBe("DATA_ERROR");
  });

  it("filters by query, category and computed status without changing the source rows", () => {
    const rows = [
      normalizeInventoryAvailabilityRow({ item_id: "1", item_code: "U-01", item_name: "夏季上衣", category: "上衣", is_active: true, available_to_request_quantity: 3 }),
      normalizeInventoryAvailabilityRow({ item_id: "2", item_code: "U-02", item_name: "冬季長褲", category: "褲子", is_active: true, available_to_request_quantity: 0 }),
    ];

    expect(inventoryAvailabilityCategories(rows)).toEqual(["上衣", "褲子"]);
    expect(filterInventoryAvailability(rows, { query: "夏季", category: "上衣", status: "AVAILABLE" }).map((row) => row.itemCode)).toEqual(["U-01"]);
    expect(rows).toHaveLength(2);
  });

  it("sorts quantity columns numerically and preserves the input order source", () => {
    const rows = [
      normalizeInventoryAvailabilityRow({ item_code: "U-10", is_active: true, available_to_request_quantity: 2 }),
      normalizeInventoryAvailabilityRow({ item_code: "U-02", is_active: true, available_to_request_quantity: 12 }),
    ];

    expect(sortInventoryAvailability(rows, "available_to_request", "desc").map((row) => row.itemCode)).toEqual(["U-02", "U-10"]);
    expect(rows.map((row) => row.itemCode)).toEqual(["U-10", "U-02"]);
  });
});
