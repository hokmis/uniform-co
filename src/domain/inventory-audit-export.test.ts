import { describe, expect, it } from "vitest";
import { generateInventoryAuditXlsx, type InventoryAuditRow, type InventoryAuditExportOptions } from "./inventory-audit-export";

describe("generateInventoryAuditXlsx", () => {
  it("generates a valid xlsx binary with proper header and rows", () => {
    const rows: InventoryAuditRow[] = [
      {
        itemId: "item-1",
        itemCode: "U-TSHIRT-L",
        itemName: "照服夏季短袖上衣",
        size: "L",
        unit: "件",
        hrOpening: 10,
        issueQty: 5,
        increaseQty: 2,
        replenishQty: 0,
        hrOnHand: 7,
        genOpening: 50,
        genIssueQty: 2,
        genOnHand: 48,
        combinedOnHand: 55,
        erpOnHand: 55,
      },
      {
        itemId: "item-2",
        itemCode: "U-TSHIRT-M",
        itemName: "照服夏季短袖上衣",
        size: "M",
        unit: "件",
        hrOpening: 20,
        issueQty: 10,
        increaseQty: 0,
        replenishQty: 5,
        hrOnHand: 15,
        genOpening: 60,
        genIssueQty: 5,
        genOnHand: 55,
        combinedOnHand: 70,
        erpOnHand: 70,
      },
    ];

    const options: InventoryAuditExportOptions = {
      year: 2026,
      month: 10,
      prevMonth: 9,
      startDate: "2026-09-21",
      endDate: "2026-10-20",
    };

    const result = generateInventoryAuditXlsx(rows, options);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBeGreaterThan(100);

    // 檢查 ZIP PK 檔頭
    expect(result[0]).toBe(0x50); // P
    expect(result[1]).toBe(0x4b); // K
  });
});
