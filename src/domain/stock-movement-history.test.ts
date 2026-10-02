import { describe, expect, it } from "vitest";
import {
  aggregateStockMovements,
  filterStockMovements,
  sortStockMovements,
  type StockMovementRow,
} from "./stock-movement-history";

describe("stock-movement-history", () => {
  const mockAvailability = [
    { item_id: "item-1", item_code: "UNT0102", item_name: "短袖制服", size: "2L", unit: "件", hr_on_hand_quantity: 30, general_on_hand_quantity: 50 },
    { item_id: "item-2", item_code: "REP009", item_name: "工作長褲", size: "XL", unit: "件", hr_on_hand_quantity: 25, general_on_hand_quantity: 20 },
  ];

  const mockHistory = [
    // 1. 員工制服需求發貨：總倉調撥出庫 10 件，人資倉淨增減為 +2 件（調撥 10 件，發給員工 8 件，隨單增庫 2 件）
    {
      posting_id: "post-shp-1",
      posting_kind: "WAREHOUSE_SHIPMENT",
      item_id: "item-1",
      item_code: "UNT0102",
      item_name: "短袖制服",
      unit: "件",
      warehouse_purpose: "GENERAL",
      quantity_delta: -10,
      source_no: "SHP-2026-001",
      occurred_on: "2026-09-25",
      posted_at: "2026-09-25T10:00:00Z",
      posted_by_name: "倉庫管理員",
    },
    {
      posting_id: "post-shp-1",
      posting_kind: "WAREHOUSE_SHIPMENT",
      item_id: "item-1",
      item_code: "UNT0102",
      item_name: "短袖制服",
      unit: "件",
      warehouse_purpose: "HR",
      quantity_delta: 2,
      source_no: "SHP-2026-001",
      occurred_on: "2026-09-25",
      posted_at: "2026-09-25T10:00:00Z",
      posted_by_name: "倉庫管理員",
    },
    // 2. 額外補庫：總倉出庫 20 件，人資倉入庫 20 件
    {
      posting_id: "post-rep-1",
      posting_kind: "REPLENISHMENT",
      item_id: "item-2",
      item_code: "REP009",
      item_name: "工作長褲",
      unit: "件",
      warehouse_purpose: "GENERAL",
      quantity_delta: -20,
      source_no: "REP-2026-002",
      occurred_on: "2026-09-28",
      posted_at: "2026-09-28T14:30:00Z",
      posted_by_name: "倉庫審核員",
    },
    {
      posting_id: "post-rep-1",
      posting_kind: "REPLENISHMENT",
      item_id: "item-2",
      item_code: "REP009",
      item_name: "工作長褲",
      unit: "件",
      warehouse_purpose: "HR",
      quantity_delta: 20,
      source_no: "REP-2026-002",
      occurred_on: "2026-09-28",
      posted_at: "2026-09-28T14:30:00Z",
      posted_by_name: "倉庫審核員",
    },
    // 3. 無關流水（如採購入庫 RECEIPT），應被排除
    {
      posting_id: "post-rcp-1",
      posting_kind: "RECEIPT",
      item_id: "item-1",
      warehouse_purpose: "GENERAL",
      quantity_delta: 100,
      source_no: "RCP-2026-001",
      posted_at: "2026-09-20T09:00:00Z",
    },
  ];

  it("aggregates ledger entries into single rows with HR delta, GENERAL delta, size, HR on hand, and General on hand", () => {
    const rows = aggregateStockMovements(mockHistory, mockAvailability);

    expect(rows.length).toBe(2);

    // 最新紀錄排在前面 (2026-09-28 額外補庫)
    const repRow = rows[0];
    expect(repRow.postingKind).toBe("REPLENISHMENT");
    expect(repRow.postingKindLabel).toBe("額外補庫調撥");
    expect(repRow.sourceNo).toBe("REP-2026-002");
    expect(repRow.itemCode).toBe("REP009");
    expect(repRow.itemName).toBe("工作長褲");
    expect(repRow.size).toBe("XL");
    expect(repRow.hrDelta).toBe(20);
    expect(repRow.generalDelta).toBe(-20);
    expect(repRow.hrOnHand).toBe(25);
    expect(repRow.generalOnHand).toBe(20);

    // 需求發貨紀錄 (2026-09-25)
    const shpRow = rows[1];
    expect(shpRow.postingKind).toBe("WAREHOUSE_SHIPMENT");
    expect(shpRow.postingKindLabel).toBe("員工需求發貨");
    expect(shpRow.sourceNo).toBe("SHP-2026-001");
    expect(shpRow.itemCode).toBe("UNT0102");
    expect(shpRow.itemName).toBe("短袖制服");
    expect(shpRow.size).toBe("2L");
    expect(shpRow.hrDelta).toBe(2);
    expect(shpRow.generalDelta).toBe(-10);
    expect(shpRow.hrOnHand).toBe(30);
    expect(shpRow.generalOnHand).toBe(50);
  });

  it("filters stock movements by query, posting kind, and date range", () => {
    const rows = aggregateStockMovements(mockHistory, mockAvailability);

    // 關鍵字搜尋「長褲」或「REP」
    expect(filterStockMovements(rows, { query: "長褲" }).length).toBe(1);
    expect(filterStockMovements(rows, { query: "SHP" }).length).toBe(1);

    // 單據類型篩選
    expect(filterStockMovements(rows, { postingKind: "REPLENISHMENT" }).length).toBe(1);
    expect(filterStockMovements(rows, { postingKind: "WAREHOUSE_SHIPMENT" }).length).toBe(1);

    // 日期篩選
    expect(filterStockMovements(rows, { startDate: "2026-09-27" }).length).toBe(1);
    expect(filterStockMovements(rows, { endDate: "2026-09-26" }).length).toBe(1);
  });

  it("sorts stock movements by various keys", () => {
    const rows = aggregateStockMovements(mockHistory, mockAvailability);

    const sortedByItem = sortStockMovements(rows, "item_code", "asc");
    expect(sortedByItem[0].itemCode).toBe("REP009");
    expect(sortedByItem[1].itemCode).toBe("UNT0102");

    const sortedByHrDelta = sortStockMovements(rows, "hr_delta", "desc");
    expect(sortedByHrDelta[0].hrDelta).toBe(20);
    expect(sortedByHrDelta[1].hrDelta).toBe(2);

    const sortedByGeneralOnHand = sortStockMovements(rows, "general_on_hand", "desc");
    expect(sortedByGeneralOnHand[0].generalOnHand).toBe(50);
    expect(sortedByGeneralOnHand[1].generalOnHand).toBe(20);
  });
});
