export type MasterDataParseError = {
  row: number;
  message: string;
};

export type MasterDataParseResult = {
  headers: string[];
  rows: Record<string, string>[];
  errors: MasterDataParseError[];
};

const maxCellLength = 1_000_000;
const maxImportBytes = 10_000_000;

function parseCsvRows(input: string): { rows: string[][]; error?: string } {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    const next = input[index + 1];
    if (character === "\0") return { rows, error: "CSV 不得包含 NUL 字元" };
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
      if (cell.length > 0) return { rows, error: "CSV 引號只能出現在欄位開頭" };
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
    if (cell.length > maxCellLength) return { rows, error: `CSV 儲存格超過 ${maxCellLength} 字元上限` };
  }
  if (quoted) return { rows, error: "CSV 引號未閉合" };
  if (cell.length > 0 || row.length > 0) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }
  return { rows: rows.filter((candidate) => candidate.some((value) => value.trim() !== "")) };
}

function isUnsafeCell(value: string): boolean {
  return /^[=+\-@]/.test(value.trim()) || /[\t\r]/.test(value);
}

export function parseMasterDataCsv(input: string, maxRows = 10_000, maxColumns = 50): MasterDataParseResult {
  if (input.length > maxImportBytes) return { headers: [], rows: [], errors: [{ row: 1, message: `檔案超過 ${maxImportBytes} bytes 上限` }] };
  const parsed = parseCsvRows(input.replace(/^\uFEFF/, ""));
  if (parsed.error) return { headers: [], rows: [], errors: [{ row: 1, message: parsed.error }] };
  if (parsed.rows.length === 0) return { headers: [], rows: [], errors: [{ row: 1, message: "CSV 缺少標題列" }] };

  const headers = parsed.rows[0].map((header) => header.trim());
  const errors: MasterDataParseError[] = [];
  if (headers.length === 0 || headers.some((header) => header === "")) {
    errors.push({ row: 1, message: "CSV 標題不可空白" });
  }
  if (headers.length > maxColumns) errors.push({ row: 1, message: `欄位數超過上限 ${maxColumns}` });
  if (new Set(headers).size !== headers.length) errors.push({ row: 1, message: "CSV 標題不可重複" });
  if (errors.length > 0) return { headers, rows: [], errors };
  if (parsed.rows.length - 1 > maxRows) {
    errors.push({ row: maxRows + 2, message: `資料列超過上限 ${maxRows}` });
  }

  const rows: Record<string, string>[] = [];
  parsed.rows.slice(1, maxRows + 1).forEach((values, offset) => {
    const rowNumber = offset + 2;
    if (values.length !== headers.length) {
      errors.push({ row: rowNumber, message: "欄位數與標題列不一致" });
      return;
    }
    if (values.some(isUnsafeCell)) {
      errors.push({ row: rowNumber, message: "拒絕含有公式或外部連結前綴的儲存格" });
      return;
    }
    rows.push(Object.fromEntries(headers.map((header, index) => [header, values[index]])));
  });
  return { headers, rows, errors };
}

export function parseMasterDataJson(input: string): MasterDataParseResult {
  if (input.length > maxImportBytes) return { headers: [], rows: [], errors: [{ row: 1, message: `檔案超過 ${maxImportBytes} bytes 上限` }] };
  try {
    const parsed: unknown = JSON.parse(input);
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((row) => row === null || typeof row !== "object" || Array.isArray(row))) {
      return { headers: [], rows: [], errors: [{ row: 1, message: "JSON 必須是非空物件陣列" }] };
    }
    const rows = parsed as Record<string, unknown>[];
    if (rows.length > 10_000) return { headers: [], rows: [], errors: [{ row: 1, message: "資料列超過上限 10000" }] };
    const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    if (headers.length > 50) return { headers, rows: [], errors: [{ row: 1, message: "欄位數超過上限 50" }] };
    const resultRows: Record<string, string>[] = [];
    const errors: MasterDataParseError[] = [];
    rows.forEach((row, index) => {
      const normalized = Object.fromEntries(headers.map((header) => [header, row[header] == null ? "" : String(row[header])]));
      if (Object.values(normalized).some((value) => value.length > maxCellLength)) {
        errors.push({ row: index + 1, message: `儲存格超過 ${maxCellLength} 字元上限` });
        return;
      }
      if (Object.values(normalized).some(isUnsafeCell)) {
        errors.push({ row: index + 1, message: "拒絕含有公式或外部連結前綴的儲存格" });
        return;
      }
      resultRows.push(normalized);
    });
    return { headers, rows: resultRows, errors };
  } catch {
    return { headers: [], rows: [], errors: [{ row: 1, message: "JSON 無法解析" }] };
  }
}

export function masterRowsToCsv(rows: Record<string, unknown>[]): string {
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const escape = (value: unknown) => {
    const text = value == null ? "" : String(value);
    const safe = isUnsafeCell(text) ? `'${text}` : text;
    return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
  };
  return [headers.map(escape).join(","), ...rows.map((row) => headers.map((header) => escape(row[header])).join(","))].join("\r\n");
}
