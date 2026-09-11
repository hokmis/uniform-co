export type EmploymentStatus = "ACTIVE" | "INACTIVE";
export type EmployeeCatalogStatus = "ALL" | EmploymentStatus;
export type EmployeeCatalogSortKey = "employeeNo" | "name" | "institution" | "department" | "status" | "hireDate";
export type EmployeeCatalogSortDirection = "asc" | "desc";

export type EmployeeCatalogEntry = {
  id: string;
  employeeNo: string;
  name: string;
  institutionCode: string;
  institutionName: string;
  departmentCode: string;
  departmentName: string;
  employmentStatus: EmploymentStatus;
  jobTitle: string;
  hireDate: string;
  terminationDate: string;
  note: string;
};

export type EmployeeEditorForm = Omit<EmployeeCatalogEntry, "id" | "institutionName" | "departmentName">;

export const emptyEmployeeEditorForm: EmployeeEditorForm = {
  employeeNo: "",
  name: "",
  institutionCode: "",
  departmentCode: "",
  employmentStatus: "ACTIVE",
  jobTitle: "",
  hireDate: "",
  terminationDate: "",
  note: "",
};

function clean(value: string): string {
  return value.trim();
}

function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function unsafeSingleLine(value: string): boolean {
  return /^[=+@-]/.test(clean(value)) || /[\t\r\n]/.test(value);
}

export function validateEmployeeEditor(form: EmployeeEditorForm): string | null {
  if (![form.employeeNo, form.name, form.institutionCode, form.departmentCode].every((value) => clean(value))) return "工號、姓名、機構與部門為必填。";
  if ([form.employeeNo, form.name, form.institutionCode, form.departmentCode, form.jobTitle].some(unsafeSingleLine) || /^[=+@-]/.test(clean(form.note))) return "文字不可使用公式前綴，單行欄位不可含 Tab 或換行。";
  if (clean(form.employeeNo).length > 100 || clean(form.name).length > 255 || clean(form.jobTitle).length > 255 || clean(form.note).length > 4000) return "員工主檔文字超過允許長度。";
  if (form.hireDate && !validIsoDate(form.hireDate)) return "到職日必須是有效日期。";
  if (form.terminationDate && !validIsoDate(form.terminationDate)) return "離職日必須是有效日期。";
  if (form.employmentStatus === "ACTIVE" && form.terminationDate) return "在職員工不可填寫離職日。";
  if (form.hireDate && form.terminationDate && form.terminationDate < form.hireDate) return "離職日不可早於到職日。";
  return null;
}

export function employeeEditorPayload(form: EmployeeEditorForm) {
  return {
    employeeNo: clean(form.employeeNo),
    name: clean(form.name),
    institutionCode: clean(form.institutionCode),
    departmentCode: clean(form.departmentCode),
    employmentStatus: form.employmentStatus,
    jobTitle: clean(form.jobTitle) || null,
    hireDate: form.hireDate || null,
    terminationDate: form.terminationDate || null,
    note: clean(form.note) || null,
  };
}

export function filterEmployeeCatalog(
  rows: readonly EmployeeCatalogEntry[],
  filter: { query: string; status: EmployeeCatalogStatus; institutionCode: string },
): EmployeeCatalogEntry[] {
  const query = clean(filter.query).toLocaleLowerCase("zh-Hant");
  return rows.filter((row) => {
    if (filter.status !== "ALL" && row.employmentStatus !== filter.status) return false;
    if (filter.institutionCode && row.institutionCode !== filter.institutionCode) return false;
    if (!query) return true;
    return [row.employeeNo, row.name, row.institutionCode, row.institutionName, row.departmentCode, row.departmentName, row.jobTitle]
      .join(" ").toLocaleLowerCase("zh-Hant").includes(query);
  });
}

export function sortEmployeeCatalog(
  rows: readonly EmployeeCatalogEntry[],
  key: EmployeeCatalogSortKey,
  direction: EmployeeCatalogSortDirection,
): EmployeeCatalogEntry[] {
  const multiplier = direction === "asc" ? 1 : -1;
  return rows.map((row, index) => ({ row, index })).sort((left, right) => {
    const value = (row: EmployeeCatalogEntry) => key === "institution"
      ? `${row.institutionCode} ${row.institutionName}`
      : key === "department"
        ? `${row.departmentCode} ${row.departmentName}`
        : key === "status"
          ? row.employmentStatus
          : row[key];
    const result = value(left.row).localeCompare(value(right.row), "zh-Hant", { numeric: true, sensitivity: "base" });
    return result ? result * multiplier : left.index - right.index;
  }).map(({ row }) => row);
}

export function employeeCatalogExportRows(rows: readonly EmployeeCatalogEntry[]) {
  return rows.map((row) => ({
    employee_no: row.employeeNo,
    name: row.name,
    institution_code: row.institutionCode,
    department_code: row.departmentCode,
    employment_status: row.employmentStatus,
    job_title: row.jobTitle,
    hire_date: row.hireDate,
    termination_date: row.terminationDate,
    note: row.note,
  }));
}
