export type EmployeeImportRow = {
  employeeNo: string;
  name: string;
  institutionCode: string;
  departmentCode: string;
  employmentStatus: "ACTIVE" | "INACTIVE";
};

export type EmployeeImportError = {
  row: number;
  code: "MISSING_HEADER" | "INVALID_COLUMN_COUNT" | "EMPTY_REQUIRED" | "DUPLICATE_EMPLOYEE_NO" | "INVALID_STATUS" | "FORMULA_CELL" | "MALFORMED_CSV";
  message: string;
};

export type EmployeeImportResult = {
  headers: string[];
  rows: EmployeeImportRow[];
  errors: EmployeeImportError[];
};

const requiredHeaders = [
  "employee_no",
  "name",
  "institution_code",
  "department_code",
  "employment_status",
] as const;

function parseCsvRows(input: string): { rows: string[][]; malformed: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    const next = input[index + 1];
    if (quoted) {
      if (character === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }
  return { rows: rows.filter((candidate) => candidate.some((value) => value.trim() !== "")), malformed: quoted };
}

function isFormulaCell(value: string): boolean {
  return /^[=+\-@]/.test(value.trim());
}

export function parseEmployeeCsv(input: string, maxRows = 10_000): EmployeeImportResult {
  if (input.length > 10_000_000) {
    return { headers: [], rows: [], errors: [{ row: 1, code: "INVALID_COLUMN_COUNT", message: "檔案超過 10 MB 上限" }] };
  }
  const csv = input.replace(/^\uFEFF/, "");
  const parsedResult = parseCsvRows(csv);
  const parsedRows = parsedResult.rows;
  if (parsedRows.length === 0) {
    return { headers: [], rows: [], errors: [{ row: 1, code: "MISSING_HEADER", message: "CSV 缺少標題列" }] };
  }

  const headers = parsedRows[0].map((header) => header.trim().toLowerCase());
  const errors: EmployeeImportError[] = [];
  if (parsedResult.malformed) {
    errors.push({ row: 1, code: "MALFORMED_CSV", message: "CSV 含有未閉合的引號" });
  }
  const missingHeaders = requiredHeaders.filter((header) => !headers.includes(header));
  for (const header of missingHeaders) {
    errors.push({ row: 1, code: "MISSING_HEADER", message: `缺少必要欄位 ${header}` });
  }
  if (missingHeaders.length > 0) {
    return { headers, rows: [], errors };
  }

  const indexOf = (header: (typeof requiredHeaders)[number]) => headers.indexOf(header);
  const seenEmployeeNos = new Set<string>();
  const rows: EmployeeImportRow[] = [];

  if (parsedRows.length - 1 > maxRows) {
    errors.push({ row: maxRows + 2, code: "INVALID_COLUMN_COUNT", message: `資料列超過上限 ${maxRows}` });
  }

  parsedRows.slice(1, maxRows + 1).forEach((values, offset) => {
    const rowNumber = offset + 2;
    if (values.length !== headers.length) {
      errors.push({ row: rowNumber, code: "INVALID_COLUMN_COUNT", message: "欄位數與標題列不一致" });
      return;
    }
    if (values.some(isFormulaCell)) {
      errors.push({ row: rowNumber, code: "FORMULA_CELL", message: "拒絕含有公式或外部連結前綴的儲存格" });
      return;
    }

    const employeeNo = values[indexOf("employee_no")]?.trim() ?? "";
    const name = values[indexOf("name")]?.trim() ?? "";
    const institutionCode = values[indexOf("institution_code")]?.trim() ?? "";
    const departmentCode = values[indexOf("department_code")]?.trim() ?? "";
    const employmentStatus = values[indexOf("employment_status")]?.trim().toUpperCase() ?? "";
    const requiredValues = [employeeNo, name, institutionCode, departmentCode];
    if (requiredValues.some((value) => value === "")) {
      errors.push({ row: rowNumber, code: "EMPTY_REQUIRED", message: "工號、姓名、機構與部門不可空白" });
      return;
    }
    if (employmentStatus !== "ACTIVE" && employmentStatus !== "INACTIVE") {
      errors.push({ row: rowNumber, code: "INVALID_STATUS", message: "employment_status 必須是 ACTIVE 或 INACTIVE" });
      return;
    }
    if (seenEmployeeNos.has(employeeNo)) {
      errors.push({ row: rowNumber, code: "DUPLICATE_EMPLOYEE_NO", message: `檔案內工號 ${employeeNo} 重複` });
      return;
    }
    seenEmployeeNos.add(employeeNo);
    rows.push({
      employeeNo,
      name,
      institutionCode,
      departmentCode,
      employmentStatus,
    });
  });

  return { headers, rows, errors };
}
