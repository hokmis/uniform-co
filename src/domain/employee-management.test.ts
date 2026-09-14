import { describe, expect, it } from "vitest";
import {
  employeeCatalogExportRows,
  employeeEditorPayload,
  emptyEmployeeEditorForm,
  filterEmployeeCatalog,
  sortEmployeeCatalog,
  validateEmployeeEditor,
  type EmployeeCatalogEntry,
} from "./employee-management";

const rows: EmployeeCatalogEntry[] = [
  { id: "2", employeeNo: "E10", name: "王小明", institutionCode: "B", institutionName: "乙機構", departmentCode: "D2", departmentName: "照護", employmentStatus: "INACTIVE", jobTitle: "照服員", hireDate: "2024-01-01", terminationDate: "2025-01-01", note: "" },
  { id: "1", employeeNo: "E2", name: "陳美玲", institutionCode: "A", institutionName: "甲機構", departmentCode: "D1", departmentName: "行政", employmentStatus: "ACTIVE", jobTitle: "專員", hireDate: "2025-02-01", terminationDate: "", note: "備註" },
];

describe("employee management", () => {
  it("validates required, date and active-status invariants", () => {
    expect(validateEmployeeEditor(emptyEmployeeEditorForm)).toBe("工號、姓名、機構與部門為必填。");
    const valid = { ...emptyEmployeeEditorForm, employeeNo: "E1", name: "測試", institutionCode: "A", departmentCode: "D1", hireDate: "2025-01-01" };
    expect(validateEmployeeEditor(valid)).toBeNull();
    expect(validateEmployeeEditor({ ...valid, terminationDate: "2025-02-01" })).toBe("在職員工不可填寫離職日。");
    expect(validateEmployeeEditor({ ...valid, employmentStatus: "INACTIVE", terminationDate: "2024-12-31" })).toBe("離職日不可早於到職日。");
  });

  it("normalizes the single-record RPC payload", () => {
    expect(employeeEditorPayload({ ...emptyEmployeeEditorForm, employeeNo: " E1 ", name: " 王小明 ", institutionCode: " A ", departmentCode: " D1 ", jobTitle: " ", note: " note " })).toEqual({ employeeNo: "E1", name: "王小明", institutionCode: "A", departmentCode: "D1", employmentStatus: "ACTIVE", jobTitle: null, hireDate: null, terminationDate: null, note: "note" });
  });

  it("filters by text, status and institution", () => {
    expect(filterEmployeeCatalog(rows, { query: "照服", status: "INACTIVE", institutionCode: "B" })).toEqual([rows[0]]);
    expect(filterEmployeeCatalog(rows, { query: "行政", status: "ACTIVE", institutionCode: "A" })).toEqual([rows[1]]);
  });

  it("sorts employee numbers naturally and exports canonical columns", () => {
    expect(sortEmployeeCatalog(rows, "employeeNo", "asc").map((row) => row.employeeNo)).toEqual(["E2", "E10"]);
    expect(employeeCatalogExportRows([rows[1]])[0]).toMatchObject({ employee_no: "E2", institution_code: "A", employment_status: "ACTIVE", job_title: "專員" });
  });
});
