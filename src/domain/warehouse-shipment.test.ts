import { describe, expect, it } from "vitest";
import { filterWarehouseShipmentQueue, sortWarehouseShipmentQueue, type WarehouseShipmentQueueRow } from "./warehouse-shipment";

const rows: WarehouseShipmentQueueRow[] = [
  { id: "2", requestNo: "REQ-002", distributionDate: "2026-09-02", rowVersion: 4, shipmentStatus: "DRAFT", shipmentNo: "SHIP-002" },
  { id: "1", requestNo: "REQ-001", distributionDate: "2026-09-01", rowVersion: 3, shipmentStatus: "READY", shipmentNo: null },
];

describe("warehouse shipment queue", () => {
  it("filters request, date and draft status without mutating rows", () => {
    expect(filterWarehouseShipmentQueue(rows, "REQ-002").map((row) => row.id)).toEqual(["2"]);
    expect(filterWarehouseShipmentQueue(rows, "已有草稿").map((row) => row.id)).toEqual(["2"]);
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
});
