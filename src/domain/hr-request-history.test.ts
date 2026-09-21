import { describe, expect, it } from "vitest";
import {
  filterHrRequestHistory,
  hrRequestStatusLabel,
  sortHrRequestHistory,
  type HrRequestHistoryRow,
} from "./hr-request-history";

const rows: HrRequestHistoryRow[] = [
  {
    id: "2",
    requestNo: "HR-002",
    status: "SUBMITTED",
    distributionDate: "2026-09-02",
    rowVersion: 2,
    createdAt: "2026-09-02T01:00:00Z",
    submittedAt: "2026-09-02T01:01:00Z",
    shippedAt: null,
    cancelledAt: null,
    note: "新人",
    shipmentNo: null,
    shipmentStatus: null,
    activeReservedQuantity: 3,
  },
  {
    id: "1",
    requestNo: "HR-001",
    status: "SHIPPED",
    distributionDate: "2026-09-01",
    rowVersion: 3,
    createdAt: "2026-09-01T01:00:00Z",
    submittedAt: "2026-09-01T01:01:00Z",
    shippedAt: "2026-09-01T02:00:00Z",
    cancelledAt: null,
    note: "換季",
    shipmentNo: "SHIP-001",
    shipmentStatus: "POSTED",
    activeReservedQuantity: 0,
  },
];

describe("HR request history rules", () => {
  it("filters by request number, note and status label", () => {
    expect(filterHrRequestHistory(rows, "新人", "ALL").map((row) => row.id)).toEqual(["2"]);
    expect(filterHrRequestHistory(rows, "已完成", "SHIPPED").map((row) => row.id)).toEqual(["1"]);
    expect(hrRequestStatusLabel("INVENTORY_REVIEW_REQUIRED")).toBe("庫存待覆核");
  });

  it("sorts dates and versions without mutating the source", () => {
    expect(sortHrRequestHistory(rows, "distribution_date", "asc").map((row) => row.id)).toEqual(["1", "2"]);
    expect(sortHrRequestHistory(rows, "row_version", "desc").map((row) => row.id)).toEqual(["1", "2"]);
    expect(rows.map((row) => row.id)).toEqual(["2", "1"]);
  });
});
