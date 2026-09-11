import { unzipSync } from "fflate";

export type ImportFileKind = "CSV" | "XLSX";

export type ImportParserLimits = {
  maxBytes: number;
  maxUncompressedBytes: number;
  maxZipEntries: number;
  maxCompressionRatio: number;
  maxSheets: number;
  maxRows: number;
  maxColumns: number;
  maxCells: number;
  maxCellLength: number;
};

export const defaultImportParserLimits: ImportParserLimits = {
  maxBytes: 10_000_000,
  maxUncompressedBytes: 50_000_000,
  maxZipEntries: 200,
  maxCompressionRatio: 100,
  maxSheets: 20,
  maxRows: 10_000,
  maxColumns: 50,
  maxCells: 500_000,
  maxCellLength: 1_000_000,
};

export type ParsedImportSheet = {
  name: string;
  rows: string[][];
};

export type ParsedImportFile = {
  kind: ImportFileKind;
  sheets: ParsedImportSheet[];
  entryNames?: string[];
};

export class ImportParserError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ImportParserError";
    this.code = code;
  }
}

function limitsWithDefaults(limits?: Partial<ImportParserLimits>): ImportParserLimits {
  return { ...defaultImportParserLimits, ...limits };
}

function isFormula(value: string): boolean {
  return /^[=+\-@]/.test(value.trim());
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ImportParserError("INVALID_ENCODING", "檔案必須是有效 UTF-8");
  }
}

function pushCell(row: string[], cell: string, limit: ImportParserLimits, rowNumber: number): void {
  if (cell.length > limit.maxCellLength) {
    throw new ImportParserError("CELL_LIMIT", `第 ${rowNumber} 列的儲存格超過 ${limit.maxCellLength} 字元`);
  }
  if (cell.includes("\0")) throw new ImportParserError("NUL_BYTE", `第 ${rowNumber} 列含有 NUL 字元`);
  if (isFormula(cell)) throw new ImportParserError("FORMULA_CELL", `第 ${rowNumber} 列含有公式儲存格`);
  row.push(cell);
}

export function parseBoundedCsv(bytes: Uint8Array, suppliedLimits?: Partial<ImportParserLimits>): ParsedImportFile {
  const limits = limitsWithDefaults(suppliedLimits);
  if (bytes.byteLength > limits.maxBytes) throw new ImportParserError("FILE_SIZE", "CSV 超過檔案大小上限");
  const input = decodeUtf8(bytes).replace(/^\uFEFF/, "");
  const sheets: ParsedImportSheet[] = [];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let sawAny = false;
  let cellCount = 0;

  const finishCell = (value: string, rowNumber: number) => {
    if (row.length >= limits.maxColumns) throw new ImportParserError("COLUMN_LIMIT", "CSV 欄數超過上限");
    pushCell(row, value, limits, rowNumber);
    cellCount += 1;
    if (cellCount > limits.maxCells) throw new ImportParserError("CELL_LIMIT", "CSV 儲存格總數超過上限");
  };

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    const next = input[index + 1];
    sawAny = true;
    if (quoted) {
      if (character === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else {
        if (character === "\r" && next !== "\n") throw new ImportParserError("MALFORMED_CSV", "CSV 含有未配對的換行");
        cell += character;
      }
    } else if (character === '"') {
      if (cell.length > 0) throw new ImportParserError("MALFORMED_CSV", "CSV 引號只能出現在欄位開頭");
      quoted = true;
    } else if (character === ",") {
      finishCell(cell, rows.length + 1);
      cell = "";
    } else if (character === "\n") {
      finishCell(cell.replace(/\r$/, ""), rows.length + 1);
      if (rows.length >= limits.maxRows) throw new ImportParserError("ROW_LIMIT", "CSV 列數超過上限");
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      if (character === "\0") throw new ImportParserError("NUL_BYTE", "CSV 含有 NUL 字元");
      cell += character;
    }
    if (cell.length > limits.maxCellLength) throw new ImportParserError("CELL_LIMIT", "CSV 儲存格超過字元上限");
  }

  if (quoted) throw new ImportParserError("MALFORMED_CSV", "CSV 含有未閉合的引號");
  if (sawAny && (cell.length > 0 || row.length > 0)) {
    finishCell(cell.replace(/\r$/, ""), rows.length + 1);
    if (rows.length >= limits.maxRows) throw new ImportParserError("ROW_LIMIT", "CSV 列數超過上限");
    if (row.some((value) => value.trim() !== "")) rows.push(row);
  }
  if (rows.length === 0) throw new ImportParserError("EMPTY_FILE", "CSV 不得為空");
  if (rows[0].length === 0 || rows[0].some((value) => value.trim() === "")) throw new ImportParserError("HEADER", "CSV 標題不可空白");
  const width = rows[0].length;
  if (width > limits.maxColumns) throw new ImportParserError("COLUMN_LIMIT", "CSV 標題欄數超過上限");
  for (const [index, candidate] of rows.entries()) {
    if (candidate.length !== width) throw new ImportParserError("COLUMN_DRIFT", `第 ${index + 1} 列欄位數與標題不一致`);
  }
  sheets.push({ name: "CSV", rows });
  return { kind: "CSV", sheets };
}

function hasPathTraversal(name: string): boolean {
  const normalized = name.replaceAll("\\", "/");
  return normalized.startsWith("/") || normalized.includes("\0") || normalized.split("/").some((part) => part === ".." || part === "");
}

function xmlUnescape(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, token: string) => {
    const lower = token.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return '"';
    if (lower === "apos") return "'";
    const code = lower.startsWith("#x") ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    return Number.isSafeInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  const expression = /([A-Za-z_][\w:.-]*)\s*=\s*(["'])(.*?)\2/g;
  for (const match of tag.matchAll(expression)) result[match[1]] = xmlUnescape(match[3]);
  return result;
}

function columnNumber(reference: string): number {
  const letters = reference.match(/^[A-Za-z]+/)?.[0] ?? "";
  let value = 0;
  for (const letter of letters.toUpperCase()) value = value * 26 + letter.charCodeAt(0) - 64;
  return value;
}

function textFromXml(fragment: string): string {
  return xmlUnescape(fragment.replace(/<[^>]+>/g, ""));
}

function extractXmlBlocks(xml: string, openingTag: RegExp, closingTag: string, label: string): string[] {
  const blocks: string[] = [];
  let cursor = 0;
  while (cursor < xml.length) {
    openingTag.lastIndex = cursor;
    const opening = openingTag.exec(xml);
    if (!opening) break;
    const bodyStart = openingTag.lastIndex;
    const closing = xml.indexOf(closingTag, bodyStart);
    if (closing < 0) throw new ImportParserError("INVALID_XLSX", `${label} XML 結構不完整`);
    blocks.push(xml.slice(bodyStart, closing));
    cursor = closing + closingTag.length;
  }
  return blocks;
}

function sharedStrings(xml: string | undefined, limit: ImportParserLimits): string[] {
  if (!xml) return [];
  const blocks = extractXmlBlocks(xml, /<si\b[^>]*>/gi, "</si>", "sharedStrings");
  if (blocks.length > limit.maxCells) throw new ImportParserError("CELL_LIMIT", "sharedStrings 儲存格總數超過上限");
  return blocks.map((body, index) => {
    const value = textFromXml([...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map((part) => part[1]).join(""));
    if (value.length > limit.maxCellLength) throw new ImportParserError("CELL_LIMIT", `sharedStrings 第 ${index + 1} 格超過上限`);
    return value;
  });
}

function worksheetRows(xml: string, shared: string[], limit: ImportParserLimits, sheetName: string, totalCellCount: { value: number }): string[][] {
  // OOXML may use namespace-prefixed tags (for example `<x:f>`). Reject
  // every namespace form before extracting values so formula cells cannot be
  // silently skipped by the bounded parser.
  if (/<(?:[A-Za-z_][\w.-]*:)?(?:f|formula)\b/i.test(xml)) {
    throw new ImportParserError("FORMULA_CELL", `${sheetName} 含有公式儲存格`);
  }
  const rows: string[][] = [];
  for (const rowBody of extractXmlBlocks(xml, /<row\b[^>]*>/gi, "</row>", sheetName)) {
    if (rows.length >= limit.maxRows) throw new ImportParserError("ROW_LIMIT", "XLSX 列數超過上限");
    const values: string[] = [];
    const kinds: string[] = [];
    for (const cellMatch of rowBody.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/gi)) {
      const tag = cellMatch[1] ?? cellMatch[3] ?? "";
      const body = cellMatch[2] ?? "";
      const attr = attributes(tag);
      const position = columnNumber(attr.r ?? "");
      if (position < 1 || position > limit.maxColumns) throw new ImportParserError("COLUMN_LIMIT", `${sheetName} 欄數超過上限`);
      while (values.length < position - 1) values.push("");
      const type = attr.t ?? "";
      const valueMatch = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/i);
      const inlineMatch = body.match(/<is\b[^>]*>([\s\S]*?)<\/is>/i);
      const raw = inlineMatch ? textFromXml(inlineMatch[1]) : xmlUnescape(valueMatch?.[1] ?? "");
      const value = type === "s" ? shared[Number(raw)] ?? "" : type === "b" ? (raw === "1" ? "TRUE" : "FALSE") : raw;
      pushCell(values, value, limit, rows.length + 1);
      kinds.push(type || "number");
      totalCellCount.value += 1;
      if (totalCellCount.value > limit.maxCells) throw new ImportParserError("CELL_LIMIT", "XLSX 儲存格總數超過上限");
    }
    if (values.length > 0) {
      if (rows.length > 0) {
        const identifierColumns = new Set(
          rows[0].map((header, index) => /^(employee[_-]?no|employeeno|item[_-]?code|itemcode|supplier[_-]?code|suppliercode|institution[_-]?code|institutioncode|department[_-]?code|departmentcode|code|工號|品號|供應商代碼|機構代碼|部門代碼)$/i.test(header.trim()) ? index : -1).filter((index) => index >= 0),
        );
        for (const index of identifierColumns) {
          if (kinds[index] !== "s" && kinds[index] !== "inlineStr") {
            throw new ImportParserError("IDENTIFIER_TYPE", `${sheetName} 的識別碼欄位不可使用數字／日期儲存格`);
          }
        }
      }
      rows.push(values);
    }
  }
  return rows;
}

export function parseBoundedXlsx(bytes: Uint8Array, suppliedLimits?: Partial<ImportParserLimits>): ParsedImportFile {
  const limits = limitsWithDefaults(suppliedLimits);
  if (bytes.byteLength > limits.maxBytes) throw new ImportParserError("FILE_SIZE", "XLSX 超過檔案大小上限");
  if (bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new ImportParserError("SIGNATURE", "XLSX 不是有效 ZIP 檔");
  const entryNames: string[] = [];
  let totalUncompressed = 0;
  let entries = 0;
  let rejected = false;
  let archive: Record<string, Uint8Array>;
  try {
    archive = unzipSync(bytes, {
      filter: (entry) => {
        entries += 1;
        entryNames.push(entry.name);
        if (entries > limits.maxZipEntries) throw new ImportParserError("ZIP_ENTRIES", "XLSX ZIP entry 數超過上限");
        if (hasPathTraversal(entry.name)) throw new ImportParserError("PATH_TRAVERSAL", "XLSX 含有不安全 ZIP 路徑");
        if (entry.originalSize > limits.maxUncompressedBytes || (entry.size > 0 && entry.originalSize / entry.size > limits.maxCompressionRatio)) {
          throw new ImportParserError("ZIP_BOMB", "XLSX 解壓大小或壓縮比超過上限");
        }
        totalUncompressed += entry.originalSize;
        if (totalUncompressed > limits.maxUncompressedBytes) throw new ImportParserError("ZIP_SIZE", "XLSX 解壓後大小超過上限");
        return true;
      },
    });
  } catch (error) {
    rejected = true;
    if (error instanceof ImportParserError) throw error;
    throw new ImportParserError("INVALID_ZIP", "XLSX ZIP 無法安全解壓");
  }
  if (rejected) throw new ImportParserError("INVALID_ZIP", "XLSX ZIP 無法安全解壓");
  const names = Object.keys(archive);
  if (!names.includes("[Content_Types].xml") || !names.includes("xl/workbook.xml")) throw new ImportParserError("XLSX_STRUCTURE", "XLSX 缺少必要 OOXML 結構");
  if (names.some((name) => /(^|\/)(vbaProject\.bin|externalLinks?|embeddings?)(\/|\.|$)/i.test(name) || /\.bin$/i.test(name))) throw new ImportParserError("UNSAFE_XLSX", "XLSX 不得含巨集、外部連結或嵌入物件");
  if (names.some((name) => /(^|\/)connections?\.xml$/i.test(name))) {
    throw new ImportParserError("UNSAFE_XLSX", "XLSX 不得含資料庫連線設定");
  }
  const xmlEntries = names.filter((name) => name.toLowerCase().endsWith(".xml") || name.toLowerCase().endsWith(".rels"));
  for (const name of xmlEntries) {
    const xml = decodeUtf8(archive[name]);
    if (/<\!DOCTYPE|<\!ENTITY|externalLink|oleObject|ddeLink|<connection\b|<dbPr\b|TargetMode\s*=\s*["']External/i.test(xml)) {
      throw new ImportParserError("UNSAFE_XLSX", "XLSX 含有外部連結、資料庫連線、嵌入或 XML entity");
    }
  }
  const worksheetNames = names.filter((name) => /^xl\/worksheets\/[^/]+\.xml$/i.test(name)).sort();
  if (worksheetNames.length === 0 || worksheetNames.length > limits.maxSheets) throw new ImportParserError("SHEET_LIMIT", "XLSX 工作表數量不符合上限");
  const shared = sharedStrings(names.includes("xl/sharedStrings.xml") ? decodeUtf8(archive["xl/sharedStrings.xml"]) : undefined, limits);
  const totalCellCount = { value: 0 };
  const sheets = worksheetNames.map((name, index) => ({ name: `Sheet${index + 1}`, rows: worksheetRows(decodeUtf8(archive[name]), shared, limits, name, totalCellCount) }));
  return { kind: "XLSX", sheets, entryNames };
}

export function parseBoundedImportFile(bytes: Uint8Array, filename: string, mimeType: string, limits?: Partial<ImportParserLimits>): ParsedImportFile {
  const lower = filename.trim().toLowerCase();
  if (lower.endsWith(".csv") && mimeType === "text/csv") return parseBoundedCsv(bytes, limits);
  if (lower.endsWith(".xlsx") && mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return parseBoundedXlsx(bytes, limits);
  throw new ImportParserError("MIME_FILENAME", "副檔名與 MIME 必須是配對的 CSV 或 XLSX");
}
