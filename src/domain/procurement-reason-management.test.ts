import { describe, expect, it } from "vitest";
import { filterProcurementReasons, sortProcurementReasons, type ProcurementReason } from "./procurement-reason-management";

const reasons: ProcurementReason[] = [
  { code: "MOQ", name: "符合最低採購量", is_active: true },
  { code: "PRICE", name: "價格調整", is_active: false },
];

describe("procurement reason management", () => {
  it("filters by keyword and active state without mutating the source", () => {
    expect(filterProcurementReasons(reasons, "最低", "ACTIVE").map((row) => row.code)).toEqual(["MOQ"]);
    expect(filterProcurementReasons(reasons, "", "INACTIVE").map((row) => row.code)).toEqual(["PRICE"]);
    expect(reasons).toHaveLength(2);
  });

  it("sorts by display fields while preserving the source order", () => {
    expect(sortProcurementReasons(reasons, "code", "desc").map((row) => row.code)).toEqual(["PRICE", "MOQ"]);
    expect(reasons.map((row) => row.code)).toEqual(["MOQ", "PRICE"]);
  });
});
