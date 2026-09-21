import { describe, expect, it } from "vitest";
import {
  buildActiveHrEmployeeOptions,
  buildHrEmployeeOptionRowsFromJoinedData,
  buildHrEmployeeOptionRowsFromMasterData,
} from "./hr-employee-options";

describe("HR employee options", () => {
  it("maps database-filtered option rows into request snapshots", () => {
    const options = buildActiveHrEmployeeOptions(
      [
        {
          id: "employee-valid",
          employee_no: "E001",
          name: "有效員工",
          institution_id: "institution-1",
          department_id: "department-1",
          institution_code: "I1",
          institution_name: "機構一",
          department_code: "D1",
          department_name: "部門一",
        },
      ],
    );

    expect(options).toEqual([
      {
        employeeId: "employee-valid",
        employeeNo: "E001",
        employeeName: "有效員工",
        institutionId: "institution-1",
        institutionCode: "I1",
        institutionName: "機構一",
        departmentId: "department-1",
        departmentCode: "D1",
        departmentName: "部門一",
      },
    ]);
  });

  it("reconstructs only active, correctly-related employee options for legacy read fallback", () => {
    expect(buildHrEmployeeOptionRowsFromMasterData(
      [
        { id: "employee-valid", employee_no: "E001", name: "有效員工", institution_id: "institution-1", department_id: "department-1", employment_status: "ACTIVE" },
        { id: "employee-inactive", employee_no: "E002", name: "離職員工", institution_id: "institution-1", department_id: "department-1", employment_status: "INACTIVE" },
        { id: "employee-wrong-parent", employee_no: "E003", name: "錯誤隸屬", institution_id: "institution-2", department_id: "department-1", employment_status: "ACTIVE" },
      ],
      [
        { id: "institution-1", code: "I1", name: "機構一", is_active: true },
        { id: "institution-2", code: "I2", name: "停用機構", is_active: false },
      ],
      [
        { id: "department-1", institution_id: "institution-1", code: "D1", name: "部門一", is_active: true },
        { id: "department-2", institution_id: "institution-1", code: "D2", name: "停用部門", is_active: false },
      ],
    )).toEqual([
      {
        id: "employee-valid",
        employee_no: "E001",
        name: "有效員工",
        institution_id: "institution-1",
        institution_code: "I1",
        institution_name: "機構一",
        department_id: "department-1",
        department_code: "D1",
        department_name: "部門一",
      },
    ]);
  });

  it("projects the same active employee scope from FK-embedded legacy rows", () => {
    expect(buildHrEmployeeOptionRowsFromJoinedData([
      {
        id: "employee-valid", employee_no: "E001", name: "有效員工", institution_id: "institution-1", department_id: "department-1", employment_status: "ACTIVE",
        institution: [{ id: "institution-1", code: "I1", name: "機構一", is_active: true }],
        department: [{ id: "department-1", institution_id: "institution-1", code: "D1", name: "部門一", is_active: true }],
      },
      {
        id: "employee-inactive", employee_no: "E002", name: "離職員工", institution_id: "institution-1", department_id: "department-1", employment_status: "INACTIVE",
        institution: { id: "institution-1", code: "I1", name: "機構一", is_active: true },
        department: { id: "department-1", institution_id: "institution-1", code: "D1", name: "部門一", is_active: true },
      },
      {
        id: "employee-stale-parent", employee_no: "E003", name: "錯誤隸屬", institution_id: "institution-2", department_id: "department-1", employment_status: "ACTIVE",
        institution: { id: "institution-2", code: "I2", name: "機構二", is_active: true },
        department: { id: "department-1", institution_id: "institution-1", code: "D1", name: "部門一", is_active: true },
      },
      {
        id: "employee-inactive-department", employee_no: "E004", name: "停用部門員工", institution_id: "institution-1", department_id: "department-2", employment_status: "ACTIVE",
        institution: { id: "institution-1", code: "I1", name: "機構一", is_active: true },
        department: { id: "department-2", institution_id: "institution-1", code: "D2", name: "停用部門", is_active: false },
      },
    ])).toEqual([
      {
        id: "employee-valid",
        employee_no: "E001",
        name: "有效員工",
        institution_id: "institution-1",
        institution_code: "I1",
        institution_name: "機構一",
        department_id: "department-1",
        department_code: "D1",
        department_name: "部門一",
      },
    ]);
  });
});
