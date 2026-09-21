import type { EmployeeSnapshot } from "./hr-request";

export type HrEmployeeOptionSourceRow = {
  id: string;
  employee_no: string;
  name: string;
  institution_id: string;
  department_id: string;
  institution_code: string;
  institution_name: string;
  department_code: string;
  department_name: string;
};

export type HrEmployeeMasterSourceRow = {
  id: string;
  employee_no: string;
  name: string;
  institution_id: string;
  department_id: string;
  employment_status: "ACTIVE" | "INACTIVE";
};

export type HrEmployeeJoinedOptionSourceRow = HrEmployeeMasterSourceRow & {
  institution: HrInstitutionOptionSourceRow | HrInstitutionOptionSourceRow[] | null;
  department: HrDepartmentOptionSourceRow | HrDepartmentOptionSourceRow[] | null;
};

export type HrInstitutionOptionSourceRow = {
  id: string;
  code: string;
  name: string;
  is_active: boolean;
};

export type HrDepartmentOptionSourceRow = {
  id: string;
  institution_id: string;
  code: string;
  name: string;
  is_active: boolean;
};

/**
 * Compatibility adapter for projects that have not applied migration 0104.
 * Preserve the view's exact ACTIVE and parent-relationship filters locally;
 * the submit RPC remains the final authority for the selected employee.
 */
export function buildHrEmployeeOptionRowsFromMasterData(
  employees: HrEmployeeMasterSourceRow[],
  institutions: HrInstitutionOptionSourceRow[],
  departments: HrDepartmentOptionSourceRow[],
): HrEmployeeOptionSourceRow[] {
  const activeInstitutions = new Map(
    institutions.filter((institution) => institution.is_active).map((institution) => [institution.id, institution]),
  );
  const activeDepartments = new Map(
    departments.filter((department) => department.is_active)
      .map((department) => [`${department.id}:${department.institution_id}`, department]),
  );

  return employees.flatMap((employee) => {
    if (employee.employment_status !== "ACTIVE") return [];
    const institution = activeInstitutions.get(employee.institution_id);
    const department = activeDepartments.get(`${employee.department_id}:${employee.institution_id}`);
    if (!institution || !department) return [];
    return [{
      id: employee.id,
      employee_no: employee.employee_no,
      name: employee.name,
      institution_id: employee.institution_id,
      institution_code: institution.code,
      institution_name: institution.name,
      department_id: employee.department_id,
      department_code: department.code,
      department_name: department.name,
    }];
  });
}

/**
 * Project the legacy fallback from one FK-embedded employee query while
 * preserving the option view's active-parent and matching-parent rules.
 */
export function buildHrEmployeeOptionRowsFromJoinedData(
  employees: HrEmployeeJoinedOptionSourceRow[],
): HrEmployeeOptionSourceRow[] {
  return employees.flatMap((employee) => {
    const institution = Array.isArray(employee.institution) ? employee.institution[0] : employee.institution;
    const department = Array.isArray(employee.department) ? employee.department[0] : employee.department;
    if (
      employee.employment_status !== "ACTIVE"
      || !institution?.is_active
      || institution.id !== employee.institution_id
      || !department?.is_active
      || department.id !== employee.department_id
      || department.institution_id !== employee.institution_id
    ) return [];
    return [{
      id: employee.id,
      employee_no: employee.employee_no,
      name: employee.name,
      institution_id: employee.institution_id,
      institution_code: institution.code,
      institution_name: institution.name,
      department_id: employee.department_id,
      department_code: department.code,
      department_name: department.name,
    }];
  });
}

/**
 * Maps rows from the database's already-filtered HR request option view.
 *
 * The view enforces ACTIVE employee plus active, correctly-related institution
 * and department. Keeping that rule in the database avoids sending several
 * master lists to the browser just to join them again.
 */
export function buildActiveHrEmployeeOptions(
  employees: HrEmployeeOptionSourceRow[],
): EmployeeSnapshot[] {
  return employees.map((employee) => ({
      employeeId: employee.id,
      employeeNo: employee.employee_no,
      employeeName: employee.name,
      institutionId: employee.institution_id,
      institutionCode: employee.institution_code,
      institutionName: employee.institution_name,
      departmentId: employee.department_id,
      departmentCode: employee.department_code,
      departmentName: employee.department_name,
  }));
}
