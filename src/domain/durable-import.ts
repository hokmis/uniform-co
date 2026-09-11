export const durableImportTypes = [
  "INSTITUTIONS",
  "DEPARTMENTS",
  "EMPLOYEES",
  "UNIFORM_ITEMS",
  "SUPPLIERS",
  "SUPPLIER_ITEMS",
  "OPENING_BALANCE",
] as const;

export type DurableImportType = (typeof durableImportTypes)[number];

export const durableImportLabels: Record<DurableImportType, string> = {
  INSTITUTIONS: "機構",
  DEPARTMENTS: "部門",
  EMPLOYEES: "員工",
  UNIFORM_ITEMS: "制服品號",
  SUPPLIERS: "供應商",
  SUPPLIER_ITEMS: "供應商品號 MOQ",
  OPENING_BALANCE: "期初庫存",
};

export const durableImportMappingVersion: Record<DurableImportType, string> = {
  INSTITUTIONS: "INSTITUTIONS-v1",
  DEPARTMENTS: "DEPARTMENTS-v1",
  EMPLOYEES: "EMPLOYEES-v1",
  UNIFORM_ITEMS: "UNIFORM_ITEMS-v1",
  SUPPLIERS: "SUPPLIERS-v1",
  SUPPLIER_ITEMS: "SUPPLIER_ITEMS-v1",
  OPENING_BALANCE: "OPENING_BALANCE-v1",
};

export const durableImportAllowedMimeTypes = [
  "text/csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
] as const;

export type DurableImportMimeType = (typeof durableImportAllowedMimeTypes)[number];

export function durableImportMimeForFilename(filename: string): DurableImportMimeType | null {
  const normalized = filename.trim().toLowerCase();
  if (normalized.endsWith(".csv")) return "text/csv";
  if (normalized.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  return null;
}

export function durableImportFingerprintPayload(input: {
  importType: DurableImportType;
  filename: string;
  mimeType: DurableImportMimeType;
  sizeBytes: number;
  mappingVersion: string;
  ttlSeconds: number;
}) {
  return {
    import_type: input.importType,
    filename: input.filename.trim().slice(0, 255),
    mime: input.mimeType,
    size: input.sizeBytes,
    mapping_version: input.mappingVersion,
    ttl_seconds: input.ttlSeconds,
  };
}
