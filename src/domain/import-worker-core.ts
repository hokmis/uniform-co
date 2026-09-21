import { ImportParserError, type ParsedImportFile } from "./import-worker-parser.ts";

const encoder = new TextEncoder();

/**
 * PostgreSQL jsonb uses a deterministic key order when it is cast to text.
 * Worker fingerprints must use the same ordering as the database RPCs.
 */
export function comparePgJsonbKeys(left: string, right: string): number {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  if (leftBytes.length !== rightBytes.length) return leftBytes.length - rightBytes.length;
  for (let index = 0; index < Math.min(leftBytes.length, rightBytes.length); index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
  }
  return 0;
}

export function pgJsonbText(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(pgJsonbText).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => comparePgJsonbKeys(left, right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}: ${pgJsonbText(child)}`).join(", ")}}`;
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  throw new TypeError("Unsupported fingerprint value");
}

export function flattenImportSheets(parsed: ParsedImportFile): string[][] {
  const populated = parsed.sheets.filter((sheet) => sheet.rows.length > 0);
  if (populated.length === 0) throw new ImportParserError("EMPTY_IMPORT", "Import workbook has no header/data rows");
  const header = populated[0].rows[0];
  const rows = [header, ...populated[0].rows.slice(1)];
  for (const sheet of populated.slice(1)) {
    if (JSON.stringify(sheet.rows[0]) !== JSON.stringify(header)) throw new ImportParserError("COLUMN_DRIFT", "Every XLSX sheet must use the same import header");
    rows.push(...sheet.rows.slice(1));
    if (rows.length > 10_001) throw new ImportParserError("ROW_LIMIT", "XLSX 總資料列數超過上限");
  }
  if (rows.length > 10_001) throw new ImportParserError("ROW_LIMIT", "XLSX 總資料列數超過上限");
  return rows;
}
