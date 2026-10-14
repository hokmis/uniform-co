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
    // 3. 人資發放更正：人資多發 1 件（發放更正差額 +1），人資倉庫存調減 -1 件
    {
      posting_id: "post-corr-1",
      posting_kind: "CORRECTION",
      movement_kind: "HR_ISSUE_CORRECTION",
      item_id: "item-1",
      item_code: "UNT0102",
      item_name: "短袖制服",
      unit: "件",
      warehouse_purpose: "HR",
      quantity_delta: -1,
      source_no: "CORR-2026-001",
      occurred_on: "2026-09-30",
      posted_at: "2026-09-30T16:00:00Z",
      posted_by_name: "人資專員",
    },
    // 4. 無關流水（如採購入庫 RECEIPT），應被排除
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

    expect(rows.length).toBe(3);

    // 最新紀錄排在前面 (2026-09-30 人資發放更正)
    const corrRow = rows[0];
    expect(corrRow.postingKind).toBe("HR_ISSUE_CORRECTION");
    expect(corrRow.postingKindLabel).toBe("人資發放更正");
    expect(corrRow.sourceNo).toBe("CORR-2026-001");
    expect(corrRow.itemCode).toBe("UNT0102");
    expect(corrRow.itemName).toBe("短袖制服");
    expect(corrRow.size).toBe("2L");
    expect(corrRow.hrDelta).toBe(-1);
    expect(corrRow.generalDelta).toBe(0);
    expect(corrRow.hrOnHand).toBe(30);
    expect(corrRow.generalOnHand).toBe(50);

    // 2026-09-28 額外補庫
    const repRow = rows[1];
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
    const shpRow = rows[2];
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

    // 關鍵字搜尋「長褲」、「REP」或更正單「CORR」
    expect(filterStockMovements(rows, { query: "長褲" }).length).toBe(1);
    expect(filterStockMovements(rows, { query: "SHP" }).length).toBe(1);
    expect(filterStockMovements(rows, { query: "CORR" }).length).toBe(1);
    expect(filterStockMovements(rows, { query: "人資發放更正" }).length).toBe(1);

    // 單據類型篩選
    expect(filterStockMovements(rows, { postingKind: "REPLENISHMENT" }).length).toBe(1);
    expect(filterStockMovements(rows, { postingKind: "WAREHOUSE_SHIPMENT" }).length).toBe(1);
    expect(filterStockMovements(rows, { postingKind: "HR_ISSUE_CORRECTION" }).length).toBe(1);

    // 日期篩選
    expect(filterStockMovements(rows, { startDate: "2026-09-29" }).length).toBe(1);
    expect(filterStockMovements(rows, { endDate: "2026-09-26" }).length).toBe(1);
  });

  it("sorts stock movements by various keys", () => {
    const rows = aggregateStockMovements(mockHistory, mockAvailability);

    const sortedByItem = sortStockMovements(rows, "item_code", "asc");
    expect(sortedByItem[0].itemCode).toBe("REP009");

    const sortedByHrDelta = sortStockMovements(rows, "hr_delta", "desc");
    expect(sortedByHrDelta[0].hrDelta).toBe(20);
    expect(sortedByHrDelta[1].hrDelta).toBe(2);
    expect(sortedByHrDelta[2].hrDelta).toBe(-1);

    const sortedByGeneralOnHand = sortStockMovements(rows, "general_on_hand", "desc");
    expect(sortedByGeneralOnHand[0].generalOnHand).toBe(50);
    expect(sortedByGeneralOnHand[2].generalOnHand).toBe(20);
  });

  it("aggregates pending submitted HR requests as reservation rows with negative HR delta", () => {
    const mockPending = [
      {
        request_id: "req-pending-1",
        request_no: "HR-20261006001",
        status: "SUBMITTED",
        distribution_date: "2026-10-06",
        created_at: "2026-10-06T09:00:00Z",
        item_id: "item-1",
        item_code: "UNT0102",
        item_name: "短袖制服",
        unit: "件",
        issue_quantity: 2,
      },
    ];

    const rows = aggregateStockMovements([], mockAvailability, mockPending);
    expect(rows.length).toBe(1);

    const resRow = rows[0];
    expect(resRow.postingKind).toBe("HR_REQUEST_RESERVATION");
    expect(resRow.postingKindLabel).toBe("需求預留(待發貨)");
    expect(resRow.sourceNo).toBe("HR-20261006001");
    expect(resRow.itemCode).toBe("UNT0102");
    expect(resRow.itemName).toBe("短袖制服");
    expect(resRow.size).toBe("2L");
    expect(resRow.hrDelta).toBe(-2);
    expect(resRow.generalDelta).toBe(0);
    expect(resRow.hrOnHand).toBe(30);
    expect(resRow.generalOnHand).toBe(50);
  });
});

