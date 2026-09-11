import type { DurableImportType } from "./durable-import";

export type SampleMasterEntity =
  | "INSTITUTIONS"
  | "DEPARTMENTS"
  | "UNIFORM_ITEMS"
  | "SUPPLIERS"
  | "SUPPLIER_ITEMS";

export type SampleRow = Record<string, string>;

const sampleMasterRows: Record<SampleMasterEntity, SampleRow[]> = {
  INSTITUTIONS: [
    { code: "DEMO-A", name: "範例機構 A", isActive: "true" },
    { code: "DEMO-B", name: "範例機構 B", isActive: "true" },
  ],
  DEPARTMENTS: [
    { institutionCode: "DEMO-A", code: "ADMIN", name: "行政部門", isActive: "true" },
    { institutionCode: "DEMO-A", code: "OPS", name: "作業部門", isActive: "true" },
    { institutionCode: "DEMO-B", code: "ADMIN", name: "行政部門", isActive: "true" },
  ],
  UNIFORM_ITEMS: [
    { code: "DEMO-SHIRT-M", name: "範例短袖上衣", unit: "件", size: "M", category: "上衣", season: "全年", isActive: "true" },
    { code: "DEMO-SHIRT-L", name: "範例短袖上衣", unit: "件", size: "L", category: "上衣", season: "全年", isActive: "true" },
    { code: "DEMO-PANTS-M", name: "範例長褲", unit: "件", size: "M", category: "下身", season: "全年", isActive: "true" },
    { code: "DEMO-PANTS-L", name: "範例長褲", unit: "件", size: "L", category: "下身", season: "全年", isActive: "true" },
  ],
  SUPPLIERS: [
    { supplierCode: "DEMO-SUPPLIER", name: "範例制服供應商", defaultCurrency: "TWD", isActive: "true" },
  ],
  SUPPLIER_ITEMS: [
    { supplierCode: "DEMO-SUPPLIER", itemCode: "DEMO-SHIRT-M", minimumOrderQuantity: "10", supplierItemCode: "DS-M", isActive: "true" },
    { supplierCode: "DEMO-SUPPLIER", itemCode: "DEMO-SHIRT-L", minimumOrderQuantity: "10", supplierItemCode: "DS-L", isActive: "true" },
    { supplierCode: "DEMO-SUPPLIER", itemCode: "DEMO-PANTS-M", minimumOrderQuantity: "10", supplierItemCode: "DP-M", isActive: "true" },
    { supplierCode: "DEMO-SUPPLIER", itemCode: "DEMO-PANTS-L", minimumOrderQuantity: "10", supplierItemCode: "DP-L", isActive: "true" },
  ],
};

export const sampleEmployeeRows: SampleRow[] = [
  {
    employee_no: "DEMO-E001",
    name: "範例員工一",
    institution_code: "DEMO-A",
    department_code: "ADMIN",
    employment_status: "ACTIVE",
  },
  {
    employee_no: "DEMO-E002",
    name: "範例員工二",
    institution_code: "DEMO-A",
    department_code: "OPS",
    employment_status: "ACTIVE",
  },
  {
    employee_no: "DEMO-E003",
    name: "範例員工三",
    institution_code: "DEMO-B",
    department_code: "ADMIN",
    employment_status: "ACTIVE",
  },
];

export const sampleOpeningBalanceRows: SampleRow[] = [
  { warehouseCode: "DEMO-HR", itemCode: "DEMO-SHIRT-M", quantity: "20" },
  { warehouseCode: "DEMO-HR", itemCode: "DEMO-SHIRT-L", quantity: "20" },
  { warehouseCode: "DEMO-HR", itemCode: "DEMO-PANTS-M", quantity: "20" },
  { warehouseCode: "DEMO-HR", itemCode: "DEMO-PANTS-L", quantity: "20" },
  { warehouseCode: "DEMO-GENERAL", itemCode: "DEMO-SHIRT-M", quantity: "50" },
  { warehouseCode: "DEMO-GENERAL", itemCode: "DEMO-SHIRT-L", quantity: "50" },
  { warehouseCode: "DEMO-GENERAL", itemCode: "DEMO-PANTS-M", quantity: "50" },
  { warehouseCode: "DEMO-GENERAL", itemCode: "DEMO-PANTS-L", quantity: "50" },
];

export function getSampleMasterRows(entityType: SampleMasterEntity): SampleRow[] {
  return sampleMasterRows[entityType].map((row) => ({ ...row }));
}

export function getSampleDurableRows(importType: DurableImportType): SampleRow[] {
  if (importType === "EMPLOYEES") return sampleEmployeeRows.map((row) => ({ ...row }));
  if (importType === "OPENING_BALANCE") return sampleOpeningBalanceRows.map((row) => ({ ...row }));
  return getSampleMasterRows(importType);
}
