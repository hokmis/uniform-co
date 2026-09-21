import { describe, expect, it } from "vitest";
import { canRefreshWarehouseShipmentQueue, changedWarehouseShipmentLines, filterWarehouseShipmentQueue, isWarehousePostConfirmed, sortWarehouseShipmentQueue, type WarehouseShipmentQueueRow } from "./warehouse-shipment";

const rows: WarehouseShipmentQueueRow[] = [
  { id: "2", source: "HR_REQUEST", requestNo: "REQ-002", distributionDate: "2026-09-02", rowVersion: 4, shipmentStatus: "DRAFT", shipmentNo: "SHIP-002" },
  { id: "1", source: "REPLENISHMENT", requestNo: "REP-001", distributionDate: "2026-09-01", rowVersion: 3, shipmentStatus: "READY", shipmentNo: null },
];

describe("warehouse shipment queue", () => {
  it("returns only shipment lines that differ from the persisted draft", () => {
    const persisted = [
      { id: "line-1", actual_transfer_quantity: 4, short_ship_reason_code: null },
      { id: "line-2", actual_transfer_quantity: 2, short_ship_reason_code: "DAMAGED" },
    ];
    const current = [
      { ...persisted[0], item_code_snapshot: "SHIRT-M" },
      { ...persisted[1], actual_transfer_quantity: 1, item_code_snapshot: "PANTS-L" },
    ];

    expect(changedWarehouseShipmentLines(current, persisted)).toEqual([current[1]]);
    expect(changedWarehouseShipmentLines(persisted, persisted)).toEqual([]);
  });

  it("treats a newly added draft line as unsaved", () => {
    const line = { id: "line-new", actual_transfer_quantity: 1, short_ship_reason_code: null };

    expect(changedWarehouseShipmentLines([line], [])).toEqual([line]);
  });

  it("confirms posting only when the returned entity and terminal status match", () => {
    expect(isWarehousePostConfirmed("HR_REQUEST", "shipment-1", { id: "shipment-1", status: "POSTED" })).toBe(true);
    expect(isWarehousePostConfirmed("REPLENISHMENT", "request-1", { id: "request-1", status: "SHIPPED" })).toBe(true);
    expect(isWarehousePostConfirmed("HR_REQUEST", "shipment-1", null)).toBe(false);
    expect(isWarehousePostConfirmed("HR_REQUEST", "shipment-1", { id: "other", status: "POSTED" })).toBe(false);
    expect(isWarehousePostConfirmed("REPLENISHMENT", "request-1", { id: "request-1", status: "SUBMITTED" })).toBe(false);
  });

  it("filters request, date and draft status without mutating rows", () => {
    expect(filterWarehouseShipmentQueue(rows, "REQ-002").map((row) => row.id)).toEqual(["2"]);
    expect(filterWarehouseShipmentQueue(rows, "已有草稿").map((row) => row.id)).toEqual(["2"]);
    expect(filterWarehouseShipmentQueue(rows, "補庫單").map((row) => row.id)).toEqual(["1"]);
    expect(filterWarehouseShipmentQueue(rows, "2026-09-01").map((row) => row.id)).toEqual(["1"]);
    expect(rows.map((row) => row.id)).toEqual(["2", "1"]);
  });

  it("sorts request number and row version deterministically", () => {
    expect(sortWarehouseShipmentQueue(rows, "request_no", "asc").map((row) => row.id)).toEqual(["1", "2"]);
    expect(sortWarehouseShipmentQueue(rows, "row_version", "desc").map((row) => row.id)).toEqual(["2", "1"]);
  });

  it("sorts distribution date without mutating rows", () => {
    expect(sortWarehouseShipmentQueue(rows, "distribution_date", "asc").map((row) => row.id)).toEqual(["1", "2"]);
    expect(rows.map((row) => row.distributionDate)).toEqual(["2026-09-02", "2026-09-01"]);
  });

  it("allows the queue to refresh while a saved draft remains selected", () => {
    expect(canRefreshWarehouseShipmentQueue({ queueLoading: false, detailsLoading: false, busy: false, draftDirty: false })).toBe(true);
    expect(canRefreshWarehouseShipmentQueue({ queueLoading: false, detailsLoading: false, busy: false, draftDirty: true })).toBe(false);
    expect(canRefreshWarehouseShipmentQueue({ queueLoading: false, detailsLoading: false, busy: true, draftDirty: false })).toBe(false);
    expect(canRefreshWarehouseShipmentQueue({ queueLoading: false, detailsLoading: true, busy: false, draftDirty: false })).toBe(false);
    expect(canRefreshWarehouseShipmentQueue({ queueLoading: true, detailsLoading: false, busy: false, draftDirty: false })).toBe(false);
  });
});
