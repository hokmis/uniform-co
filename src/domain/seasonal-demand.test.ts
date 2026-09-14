import { describe, expect, it } from "vitest";
import { filterSeasonalDemandQueue, sortSeasonalDemandQueue, type SeasonalDemandQueueRow } from "./seasonal-demand";

const rows: SeasonalDemandQueueRow[] = [
  { id: "2", employeeNo: "E-002", employeeName: "王小明", itemCode: "U-002", itemName: "長袖上衣", size: "L", quantity: 2, updatedAt: "2026-08-30T10:00:00Z", hrModified: true },
  { id: "1", employeeNo: "E-001", employeeName: "李小華", itemCode: "U-001", itemName: "短袖上衣", size: "M", quantity: 12, updatedAt: "2026-08-29T10:00:00Z", hrModified: false },
];

describe("seasonal demand queue", () => {
  it("filters employee, item, quantity and HR modification status without mutating rows", () => {
    expect(filterSeasonalDemandQueue(rows, "王小明").map((row) => row.id)).toEqual(["2"]);
    expect(filterSeasonalDemandQueue(rows, "12").map((row) => row.id)).toEqual(["1"]);
    expect(filterSeasonalDemandQueue(rows, "HR 已修改").map((row) => row.id)).toEqual(["2"]);
    expect(rows.map((row) => row.id)).toEqual(["2", "1"]);
  });

  it("sorts quantity numerically and keeps source rows unchanged", () => {
    expect(sortSeasonalDemandQueue(rows, "quantity", "asc").map((row) => row.quantity)).toEqual([2, 12]);
    expect(sortSeasonalDemandQueue(rows, "quantity", "desc").map((row) => row.quantity)).toEqual([12, 2]);
    expect(rows.map((row) => row.quantity)).toEqual([2, 12]);
  });

  it("sorts employee and update time deterministically", () => {
    expect(sortSeasonalDemandQueue(rows, "employee_no", "asc").map((row) => row.id)).toEqual(["1", "2"]);
    expect(sortSeasonalDemandQueue(rows, "updated_at", "asc").map((row) => row.id)).toEqual(["1", "2"]);
  });
});
