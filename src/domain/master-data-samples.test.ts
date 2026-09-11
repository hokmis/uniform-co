import { describe, expect, it } from "vitest";
import { getSampleDurableRows, getSampleMasterRows, sampleEmployeeRows, sampleOpeningBalanceRows } from "./master-data-samples";

describe("master data sample fixtures", () => {
  it("uses a distinct DEMO namespace for master data", () => {
    for (const entityType of ["INSTITUTIONS", "DEPARTMENTS", "UNIFORM_ITEMS", "SUPPLIERS", "SUPPLIER_ITEMS"] as const) {
      const rows = getSampleMasterRows(entityType);
      expect(rows.length).toBeGreaterThan(0);
      expect(JSON.stringify(rows)).toContain("DEMO-");
    }
  });

  it("keeps employee and opening balance samples aligned with the demo references", () => {
    expect(sampleEmployeeRows.every((row) => row.employee_no.startsWith("DEMO-"))).toBe(true);
    expect(sampleOpeningBalanceRows.every((row) => row.warehouseCode.startsWith("DEMO-"))).toBe(true);
    expect(getSampleDurableRows("EMPLOYEES")).toEqual(sampleEmployeeRows);
    expect(getSampleDurableRows("OPENING_BALANCE")).toEqual(sampleOpeningBalanceRows);
  });
});
