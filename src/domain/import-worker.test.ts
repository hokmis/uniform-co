import { describe, expect, it } from "vitest";
import { buildImportPreviewRows, chunkImportRows, type ImportReferenceRow } from "./import-worker";

describe("durable import worker preview seam", () => {
  it("classifies employee rows as INSERT, UPDATE, and SKIP against the reference snapshot", () => {
    const rows = buildImportPreviewRows(
      "EMPLOYEES",
      [["employee_no", "name", "institution_code", "department_code", "employment_status"], ["E001", "王小明", "A", "D", "ACTIVE"], ["E002", "李小華", "A", "D", "ACTIVE"], ["E003", "新員工", "A", "D", "ACTIVE"]],
      [
        { kind: "INSTITUTION", code: "A", isActive: true },
        { kind: "DEPARTMENT", institutionCode: "A", code: "D", isActive: true },
        { employeeNo: "E001", name: "王小明", institutionCode: "A", departmentCode: "D", employmentStatus: "ACTIVE" },
        { employeeNo: "E002", name: "舊姓名", institutionCode: "A", departmentCode: "D", employmentStatus: "ACTIVE" },
      ],
    );

    expect(rows.map((row) => row.proposed_action)).toEqual(["SKIP", "UPDATE", "INSERT"]);
    expect(rows[1].diffs).toEqual([{ field_name: "name", old_value: "舊姓名", new_value: "李小華" }]);
  });

  it("reports missing/unknown columns as row errors instead of guessing", () => {
    const rows = buildImportPreviewRows("SUPPLIERS", [["supplier_code", "unexpected"], ["S001", "x"]], []);
    expect(rows).toHaveLength(1);
    expect(rows[0].proposed_action).toBe("ERROR");
    expect(rows[0].validation_errors.map((error) => error.code)).toEqual(expect.arrayContaining(["UNKNOWN_COLUMN", "MISSING_REQUIRED_COLUMN", "MISSING_REQUIRED_COLUMN"]));
  });

  it("chunks preview rows using durable one-based row ranges", () => {
    const reference: ImportReferenceRow[] = [];
    const rows = buildImportPreviewRows("INSTITUTIONS", [["code", "name"], ["A", "甲"], ["B", "乙"], ["C", "丙"]], reference);
    expect(chunkImportRows(rows, 2).map((chunk) => [chunk.start_row_number, chunk.end_row_number, chunk.rows.map((row) => row.row_number)])).toEqual([
      [1, 2, [1, 2]],
      [3, 3, [3]],
    ]);
  });

  it("rejects duplicate identities, invalid dates, and blank booleans", () => {
    const rows = buildImportPreviewRows("EMPLOYEES", [["employee_no", "name", "institution_code", "department_code", "employment_status", "hire_date"], [" E001 ", "甲", "A", "D", "active", "2024-02-30"], ["E001", "乙", "A", "D", "active", "2024-02-28"]], [
      { kind: "INSTITUTION", code: "A", isActive: true },
      { kind: "DEPARTMENT", institutionCode: "A", code: "D", isActive: true },
      { kind: "EMPLOYEE", employeeNo: "E001", name: "甲", institutionCode: "A", departmentCode: "D", employmentStatus: "ACTIVE" },
    ]);
    expect(rows[0].validation_errors.map((error) => error.code)).toEqual(expect.arrayContaining(["DUPLICATE_IDENTITY", "INVALID_DATE"]));
    expect(rows[0].normalized_values).toBeNull();
    const booleanRows = buildImportPreviewRows("INSTITUTIONS", [["code", "name", "is_active"], ["A", "甲", ""]], []);
    expect(booleanRows[0].normalized_values?.isActive).toBeUndefined();
  });
});
