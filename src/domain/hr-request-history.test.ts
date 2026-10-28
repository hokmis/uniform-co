import { describe, expect, it } from "vitest";
import {
  filterHrRequestHistory,
  getDefaultHrRequestDateRange,
  hrRequestStatusLabel,
  shiftHrRequestDateRange,
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

  it("filters by requestType such as replenishment", () => {
    const mixedRows: HrRequestHistoryRow[] = [
      ...rows,
      {
        id: "rep-1",
        requestType: "REPLENISHMENT",
        requestNo: "REP-20260930-001",
        status: "SUBMITTED",
        distributionDate: "2026-09-30",
        rowVersion: 1,
        createdAt: "2026-09-30T05:00:00Z",
        submittedAt: "2026-09-30T05:01:00Z",
        shippedAt: null,
        cancelledAt: null,
        note: "二課額外補庫",
        shipmentNo: null,
        shipmentStatus: null,
        activeReservedQuantity: 0,
      },
    ];

    expect(filterHrRequestHistory(mixedRows, "額外補庫", "ALL").map((r) => r.id)).toEqual(["rep-1"]);
    expect(filterHrRequestHistory(mixedRows, "REP-20260930", "ALL").map((r) => r.id)).toEqual(["rep-1"]);
    expect(filterHrRequestHistory(mixedRows, "", "SUBMITTED").map((r) => r.id)).toEqual(["2", "rep-1"]);
  });

  it("sorts dates and versions without mutating the source", () => {
    expect(sortHrRequestHistory(rows, "distribution_date", "asc").map((row) => row.id)).toEqual(["1", "2"]);
    expect(sortHrRequestHistory(rows, "row_version", "desc").map((row) => row.id)).toEqual(["1", "2"]);
    expect(rows.map((row) => row.id)).toEqual(["2", "1"]);
  });

  it("filters by month", () => {
    expect(filterHrRequestHistory(rows, "", "ALL", "2026-09").map((row) => row.id)).toEqual(["2", "1"]);
    expect(filterHrRequestHistory(rows, "", "ALL", "2026-10").map((row) => row.id)).toEqual([]);
    expect(filterHrRequestHistory(rows, "新人", "ALL", "2026-09").map((row) => row.id)).toEqual(["2"]);
  });

  it("filters by custom date range", () => {
    expect(filterHrRequestHistory(rows, "", "ALL", { startDate: "2026-09-02", endDate: "2026-09-02" }).map((row) => row.id)).toEqual(["2"]);
    expect(filterHrRequestHistory(rows, "", "ALL", { startDate: "2026-09-01", endDate: "2026-09-01" }).map((row) => row.id)).toEqual(["1"]);
    expect(filterHrRequestHistory(rows, "", "ALL", { startDate: "2026-09-01", endDate: "2026-09-30" }).map((row) => row.id)).toEqual(["2", "1"]);
    expect(filterHrRequestHistory(rows, "", "ALL", { startDate: "2026-09-02" }).map((row) => row.id)).toEqual(["2"]);
    expect(filterHrRequestHistory(rows, "", "ALL", { endDate: "2026-09-01" }).map((row) => row.id)).toEqual(["1"]);
    expect(filterHrRequestHistory(rows, "", "ALL", "2026-09-01", "2026-09-01").map((row) => row.id)).toEqual(["1"]);
  });

  it("calculates default date range with 20th cutoff (before or on 20th vs after 20th)", () => {
    // 2026-10-15 (10月15日 <= 20) -> 上月21日(2026-09-21) 至 本月20日(2026-10-20)
    const oct15 = new Date("2026-10-15T12:00:00+08:00");
    expect(getDefaultHrRequestDateRange(oct15)).toEqual({
      startDate: "2026-09-21",
      endDate: "2026-10-20",
    });

    // 2026-10-21 (10月21日 > 20) -> 本月21日(2026-10-21) 至 下月20日(2026-11-20)
    const oct21 = new Date("2026-10-21T12:00:00+08:00");
    expect(getDefaultHrRequestDateRange(oct21)).toEqual({
      startDate: "2026-10-21",
      endDate: "2026-11-20",
    });

    // 2026-12-25 (12月25日 > 20, 跨年) -> 本月21日(2026-12-21) 至 隔年1月20日(2027-01-20)
    const dec25 = new Date("2026-12-25T12:00:00+08:00");
    expect(getDefaultHrRequestDateRange(dec25)).toEqual({
      startDate: "2026-12-21",
      endDate: "2027-01-20",
    });

    // 2027-01-15 (跨年1月15日 <= 20) -> 上月21日(2026-12-21) 至 本月20日(2027-01-20)
    const jan15 = new Date("2027-01-15T12:00:00+08:00");
    expect(getDefaultHrRequestDateRange(jan15)).toEqual({
      startDate: "2026-12-21",
      endDate: "2027-01-20",
    });
  });

  it("shifts date range to previous or next cycle correctly", () => {
    // 從 2026-11-20 往前切換至上一期
    expect(shiftHrRequestDateRange("2026-11-20", "prev")).toEqual({
      startDate: "2026-09-21",
      endDate: "2026-10-20",
    });

    // 從 2026-10-20 往後切換至下一期
    expect(shiftHrRequestDateRange("2026-10-20", "next")).toEqual({
      startDate: "2026-10-21",
      endDate: "2026-11-20",
    });

    // 跨年上一期：從 2027-01-20 往前切換
    expect(shiftHrRequestDateRange("2027-01-20", "prev")).toEqual({
      startDate: "2026-11-21",
      endDate: "2026-12-20",
    });

    // 跨年下一期：從 2026-12-20 往後切換
    expect(shiftHrRequestDateRange("2026-12-20", "next")).toEqual({
      startDate: "2026-12-21",
      endDate: "2027-01-20",
    });
  });
});
