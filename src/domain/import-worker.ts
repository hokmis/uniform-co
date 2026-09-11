import type { DurableImportType } from "./durable-import";

export type ImportReferenceRow = Record<string, string | boolean | number | null | undefined>;

export type ImportPreviewError = {
  code: string;
  message: string;
};

export type ImportPreviewDiff = {
  field_name: string;
  old_value: string | boolean | number | null;
  new_value: string;
};

export type ImportPreviewRow = {
  row_number: number;
  raw_values: Record<string, string>;
  normalized_values: Record<string, string> | null;
  proposed_action: "INSERT" | "UPDATE" | "SKIP" | "ERROR";
  validation_errors: ImportPreviewError[];
  diffs: ImportPreviewDiff[];
};

export type ImportPreviewChunk = {
  start_row_number: number;
  end_row_number: number;
  rows: ImportPreviewRow[];
};

type ImportField = {
  name: string;
  aliases: string[];
  required?: boolean;
};

const fields: Record<DurableImportType, ImportField[]> = {
  INSTITUTIONS: [
    { name: "code", aliases: ["code", "institution_code", "institutioncode"], required: true },
    { name: "name", aliases: ["name", "institution_name", "institutionname"], required: true },
    { name: "isActive", aliases: ["isactive", "is_active", "active"] },
  ],
  DEPARTMENTS: [
    { name: "institutionCode", aliases: ["institutioncode", "institution_code"], required: true },
    { name: "code", aliases: ["code", "department_code", "departmentcode"], required: true },
    { name: "name", aliases: ["name", "department_name", "departmentname"], required: true },
    { name: "isActive", aliases: ["isactive", "is_active", "active"] },
  ],
  EMPLOYEES: [
    { name: "employeeNo", aliases: ["employeeno", "employee_no", "employee_number", "工號"], required: true },
    { name: "name", aliases: ["name", "employee_name", "employeename", "姓名"], required: true },
    { name: "institutionCode", aliases: ["institutioncode", "institution_code", "機構代碼"], required: true },
    { name: "departmentCode", aliases: ["departmentcode", "department_code", "部門代碼"], required: true },
    { name: "employmentStatus", aliases: ["employmentstatus", "employment_status", "status", "在職狀態"], required: true },
    { name: "jobTitle", aliases: ["jobtitle", "job_title", "職稱"] },
    { name: "hireDate", aliases: ["hiredate", "hire_date", "到職日"] },
    { name: "terminationDate", aliases: ["terminationdate", "termination_date", "離職日"] },
    { name: "note", aliases: ["note", "備註"] },
  ],
  UNIFORM_ITEMS: [
    { name: "code", aliases: ["code", "item_code", "itemcode", "品號"], required: true },
    { name: "name", aliases: ["name", "item_name", "itemname", "品名"], required: true },
    { name: "unit", aliases: ["unit", "計量單位"], required: true },
    { name: "size", aliases: ["size", "尺寸"] },
    { name: "category", aliases: ["category", "類別"] },
    { name: "season", aliases: ["season", "季別"] },
    { name: "isActive", aliases: ["isactive", "is_active", "active"] },
  ],
  SUPPLIERS: [
    { name: "supplierCode", aliases: ["suppliercode", "supplier_code", "供應商代碼"], required: true },
    { name: "name", aliases: ["name", "supplier_name", "suppliername", "供應商名稱"], required: true },
    { name: "defaultCurrency", aliases: ["defaultcurrency", "default_currency", "currency", "幣別"] },
    { name: "isActive", aliases: ["isactive", "is_active", "active"] },
  ],
  SUPPLIER_ITEMS: [
    { name: "supplierCode", aliases: ["suppliercode", "supplier_code", "供應商代碼"], required: true },
    { name: "itemCode", aliases: ["itemcode", "item_code", "品號"], required: true },
    { name: "minimumOrderQuantity", aliases: ["minimumorderquantity", "minimum_order_quantity", "moq"], required: true },
    { name: "supplierItemCode", aliases: ["supplieritemcode", "supplier_item_code", "供應商品號"] },
    { name: "isActive", aliases: ["isactive", "is_active", "active"] },
  ],
  OPENING_BALANCE: [
    { name: "warehouseCode", aliases: ["warehousecode", "warehouse_code", "倉庫代碼"], required: true },
    { name: "itemCode", aliases: ["itemcode", "item_code", "品號"], required: true },
    { name: "quantity", aliases: ["quantity", "數量"], required: true },
  ],
};

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function fieldConfig(type: DurableImportType): Map<string, ImportField> {
  return new Map(fields[type].flatMap((field) => field.aliases.map((alias) => [normalizeHeader(alias), field] as const)));
}

function identityKey(type: DurableImportType, row: Record<string, string>): string {
  switch (type) {
    case "DEPARTMENTS": return `${row.institutionCode ?? ""}\u0000${row.code ?? ""}`;
    case "SUPPLIER_ITEMS": return `${row.supplierCode ?? ""}\u0000${row.itemCode ?? ""}`;
    case "OPENING_BALANCE": return `${row.warehouseCode ?? ""}\u0000${row.itemCode ?? ""}`;
    case "EMPLOYEES": return row.employeeNo ?? "";
    case "SUPPLIERS": return row.supplierCode ?? "";
    default: return row.code ?? "";
  }
}

function referenceIdentityKey(type: DurableImportType, row: ImportReferenceRow): string {
  return identityKey(type, Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value == null ? "" : String(value)])));
}

function comparableFields(type: DurableImportType): string[] {
  return fields[type].map((field) => field.name);
}

function referenceKind(type: DurableImportType): string {
  switch (type) {
    case "INSTITUTIONS": return "INSTITUTION";
    case "DEPARTMENTS": return "DEPARTMENT";
    case "EMPLOYEES": return "EMPLOYEE";
    case "UNIFORM_ITEMS": return "UNIFORM_ITEM";
    case "SUPPLIERS": return "SUPPLIER";
    case "SUPPLIER_ITEMS": return "SUPPLIER_ITEM";
    default: return "OPENING_BALANCE";
  }
}

function normalizeBoolean(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "y", "是"].includes(normalized)) return "true";
  if (["false", "0", "no", "n", "否"].includes(normalized)) return "false";
  return null;
}

function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function normalizeValues(type: DurableImportType, row: Record<string, string>): Record<string, string> {
  const normalized = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value.trim()]));
  if (normalized.isActive) {
    const booleanValue = normalizeBoolean(normalized.isActive);
    if (booleanValue) normalized.isActive = booleanValue;
  }
  if (type === "EMPLOYEES" && normalized.employmentStatus) normalized.employmentStatus = normalized.employmentStatus.toUpperCase();
  return normalized;
}

function referenceValue(reference: ImportReferenceRow, field: string): string {
  const value = reference[field];
  if (typeof value === "boolean") return value ? "true" : "false";
  return value == null ? "" : String(value).trim();
}

function activeReference(reference: ImportReferenceRow): boolean {
  const value = reference.isActive;
  return value === undefined || value === null || value === true || String(value).toLowerCase() === "true";
}

function validateRow(type: DurableImportType, row: Record<string, string>, missingColumns: ImportField[], unknownColumns: string[]): ImportPreviewError[] {
  const errors: ImportPreviewError[] = [];
  for (const field of missingColumns) errors.push({ code: "MISSING_REQUIRED_COLUMN", message: `缺少必要欄位 ${field.name}` });
  for (const field of unknownColumns) errors.push({ code: "UNKNOWN_COLUMN", message: `不支援欄位 ${field}` });
  for (const field of fields[type].filter((candidate) => candidate.required)) {
    if (!row[field.name]?.trim()) errors.push({ code: "EMPTY_REQUIRED", message: `${field.name} 不可空白` });
  }
  if (type === "EMPLOYEES" && row.employmentStatus && !["ACTIVE", "INACTIVE"].includes(row.employmentStatus.toUpperCase())) {
    errors.push({ code: "INVALID_STATUS", message: "employmentStatus 必須為 ACTIVE 或 INACTIVE" });
  }
  for (const field of ["hireDate", "terminationDate"]) {
    if (row[field] && !validIsoDate(row[field])) errors.push({ code: "INVALID_DATE", message: `${field} 必須為有效 YYYY-MM-DD 日期` });
  }
  for (const field of ["isActive"]) {
    if (row[field] && normalizeBoolean(row[field]) === null) errors.push({ code: "INVALID_BOOLEAN", message: `${field} 必須為 true/false` });
  }
  if (type === "SUPPLIER_ITEMS" && row.minimumOrderQuantity && !/^[1-9][0-9]{0,17}$/.test(row.minimumOrderQuantity)) {
    errors.push({ code: "INVALID_MOQ", message: "minimumOrderQuantity 必須為正整數" });
  }
  if (type === "OPENING_BALANCE" && row.quantity && !/^\d{1,18}$/.test(row.quantity)) {
    errors.push({ code: "INVALID_QUANTITY", message: "quantity 必須為非負整數" });
  }
  return errors;
}

export function buildImportPreviewRows(type: DurableImportType, sheetRows: string[][], references: ImportReferenceRow[]): ImportPreviewRow[] {
  const [headerRow, ...dataRows] = sheetRows;
  if (!headerRow) return [];
  const config = fieldConfig(type);
  const headerFields = headerRow.map((header) => config.get(normalizeHeader(header)) ?? null);
  const unknownColumns = headerRow.flatMap((header, index) => headerFields[index] ? [] : [header.trim() || `column_${index + 1}`]);
  const seenHeaders = new Set<string>();
  const duplicateColumns = headerFields.flatMap((field) => {
    if (!field || seenHeaders.has(field.name)) return field ? [field.name] : [];
    seenHeaders.add(field.name);
    return [];
  });
  const presentNames = new Set(headerFields.filter((field): field is ImportField => field !== null).map((field) => field.name));
  const missingColumns = fields[type].filter((field) => field.required && !presentNames.has(field.name));
  const mainReferences = references.filter((reference) => reference.kind === referenceKind(type) || (!reference.kind && type !== "OPENING_BALANCE"));
  const referenceByKey = new Map(mainReferences.map((reference) => [referenceIdentityKey(type, reference), reference]));
  const crossReferences = (kind: string, keyField: string) => new Map(references.filter((reference) => reference.kind === kind).map((reference) => [referenceValue(reference, keyField), reference]));
  const institutions = crossReferences("INSTITUTION", "code");
  const departments = new Map(references.filter((reference) => reference.kind === "DEPARTMENT").map((reference) => [`${referenceValue(reference, "institutionCode")}\u0000${referenceValue(reference, "code")}`, reference]));
  const suppliers = crossReferences("SUPPLIER", "supplierCode");
  const items = crossReferences("UNIFORM_ITEM", "code");
  const warehouses = crossReferences("WAREHOUSE", "code");
  const duplicateCounts = new Map<string, number>();
  for (const values of dataRows) {
    const raw = normalizeValues(type, Object.fromEntries(headerFields.flatMap((field, columnIndex) => field ? [[field.name, values[columnIndex] ?? ""]] as const : [])));
    const key = identityKey(type, raw);
    if (key.trim()) duplicateCounts.set(key, (duplicateCounts.get(key) ?? 0) + 1);
  }
  return dataRows.map((values, index) => {
    const rawValues: Record<string, string> = {};
    headerFields.forEach((field, columnIndex) => {
      if (field) rawValues[field.name] = values[columnIndex] ?? "";
    });
    const errors = validateRow(type, rawValues, missingColumns, [...unknownColumns, ...duplicateColumns.map((field) => `重複欄位 ${field}`)]);
    const normalizedValues = normalizeValues(type, rawValues);
    if (normalizedValues.isActive === "") delete normalizedValues.isActive;
    const identity = identityKey(type, normalizedValues);
    if (identity.trim() && (duplicateCounts.get(identity) ?? 0) > 1) errors.push({ code: "DUPLICATE_IDENTITY", message: `檔案內識別鍵重複：${identity.replace(/\u0000/g, "/")}` });
    const requireActive = (reference: ImportReferenceRow | undefined, label: string) => {
      if (!reference) errors.push({ code: "REFERENCE_NOT_FOUND", message: `${label} 不存在於已凍結主檔` });
      else if (!activeReference(reference)) errors.push({ code: "REFERENCE_INACTIVE", message: `${label} 已停用` });
    };
    if (type === "DEPARTMENTS" && normalizedValues.institutionCode) requireActive(institutions.get(normalizedValues.institutionCode), `機構 ${normalizedValues.institutionCode}`);
    if (type === "EMPLOYEES") {
      if (normalizedValues.institutionCode) requireActive(institutions.get(normalizedValues.institutionCode), `機構 ${normalizedValues.institutionCode}`);
      if (normalizedValues.departmentCode) {
        const department = departments.get(`${normalizedValues.institutionCode ?? ""}\u0000${normalizedValues.departmentCode}`);
        requireActive(department, `部門 ${normalizedValues.departmentCode}`);
      }
    }
    if (type === "SUPPLIER_ITEMS") {
      if (normalizedValues.supplierCode) requireActive(suppliers.get(normalizedValues.supplierCode), `供應商 ${normalizedValues.supplierCode}`);
      if (normalizedValues.itemCode) requireActive(items.get(normalizedValues.itemCode), `品號 ${normalizedValues.itemCode}`);
    }
    if (type === "OPENING_BALANCE") {
      if (normalizedValues.warehouseCode) requireActive(warehouses.get(normalizedValues.warehouseCode), `倉庫 ${normalizedValues.warehouseCode}`);
      if (normalizedValues.itemCode) requireActive(items.get(normalizedValues.itemCode), `品號 ${normalizedValues.itemCode}`);
    }
    const existing = referenceByKey.get(identity);
    const diffs: ImportPreviewDiff[] = [];
    if (!errors.length && existing) {
      for (const field of comparableFields(type)) {
        const next = normalizedValues[field] ?? "";
        if (!next) continue;
        const previous = referenceValue(existing, field);
        if (previous !== next) diffs.push({ field_name: field, old_value: existing[field] == null ? null : existing[field] as string | boolean | number, new_value: next });
      }
    }
    return {
      row_number: index + 1,
      raw_values: rawValues,
      normalized_values: errors.length ? null : normalizedValues,
      proposed_action: errors.length ? "ERROR" : existing ? (diffs.length ? "UPDATE" : "SKIP") : "INSERT",
      validation_errors: errors,
      diffs,
    };
  });
}

export function chunkImportRows(rows: ImportPreviewRow[], chunkSize = 500): ImportPreviewChunk[] {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new RangeError("chunkSize must be a positive integer");
  const chunks: ImportPreviewChunk[] = [];
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunkRows = rows.slice(offset, offset + chunkSize);
    chunks.push({ start_row_number: chunkRows[0].row_number, end_row_number: chunkRows[chunkRows.length - 1].row_number, rows: chunkRows });
  }
  return chunks;
}
