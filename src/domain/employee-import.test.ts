import { describe, expect, it } from "vitest";
import { parseEmployeeCsv } from "./employee-import";

describe("employee CSV import preview", () => {
  it("parses BOM and quoted fields", () => {
    const result = parseEmployeeCsv(
      '\uFEFFemployee_no,name,institution_code,department_code,employment_status\nE001,"王,小明",ABC,A,ACTIVE\n',
    );
    expect(result.errors).toEqual([]);
    expect(result.rows[0]).toMatchObject({ employeeNo: "E001", name: "王,小明" });
  });

  it("rejects duplicate employee numbers and invalid statuses", () => {
    const result = parseEmployeeCsv(
      "employee_no,name,institution_code,department_code,employment_status\nE001,A,ABC,A,ACTIVE\nE001,B,ABD,B,ACTIVE\nE002,C,ABD,B,UNKNOWN\n",
    );
    expect(result.errors.map((error) => error.code)).toEqual([
      "DUPLICATE_EMPLOYEE_NO",
      "INVALID_STATUS",
    ]);
  });

  it("rejects formula-injection cells before preview", () => {
    const result = parseEmployeeCsv(
      "employee_no,name,institution_code,department_code,employment_status\n=HYPERLINK(\"x\"),A,ABC,A,ACTIVE\n",
    );
    expect(result.errors[0].code).toBe("FORMULA_CELL");
    expect(result.rows).toEqual([]);
  });

  it("rejects unterminated quoted cells", () => {
    const result = parseEmployeeCsv(
      'employee_no,name,institution_code,department_code,employment_status\nE001,A,ABC,A,"ACTIVE\n',
    );
    expect(result.errors.some((error) => error.code === "MALFORMED_CSV")).toBe(true);
  });
});
