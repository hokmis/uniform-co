export type AdjustmentLine = { item_id: string; quantity_delta: number; reason: string };
export type AdjustmentImportRow = { item_code: string; quantity_delta: number; reason: string };
export const ADJUSTMENT_MAX_LINES = 1000;
export const ADJUSTMENT_MAX_DELTA = 10_000_000;

export function signedAdjustmentQuantity(value: string): number {
  if (!/^[+-]?\d+$/.test(value.trim())) throw new Error("調整數量必須是正數或負數整數。");
  const quantity = Number(value);
  if (!Number.isSafeInteger(quantity) || quantity === 0 || Math.abs(quantity) > ADJUSTMENT_MAX_DELTA) {
    throw new Error("調整數量不得為零，且絕對值不得超過 10,000,000。");
  }
  return quantity;
}

export function parseAdjustmentCsv(input: string): AdjustmentImportRow[] {
  if (new TextEncoder().encode(input).length > 1_000_000 || input.includes("\0")) throw new Error("檔案超過 1 MB 或包含無效字元。");
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false, closed = false;
  const source = input.replace(/^\uFEFF/, "");
  const pushCell = () => { row.push(cell); cell = ""; closed = false; };
  const pushRow = () => { pushCell(); if (row.some((value) => value.trim())) rows.push(row); row = []; };
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') { cell += '"'; index++; }
        else { quoted = false; closed = true; }
      } else cell += char;
    } else if (char === '"') {
      if (cell || closed) throw new Error("CSV 引號格式錯誤。");
      quoted = true;
    } else if (char === ",") pushCell();
    else if (char === "\n" || char === "\r") { pushRow(); if (char === "\r" && source[index + 1] === "\n") index++; }
    else { if (closed) throw new Error("CSV 引號後有無效內容。"); cell += char; }
  }
  if (quoted) throw new Error("CSV 引號未結束。");
  pushRow();
  const aliases: Record<string, string> = { 品號: "item_code", 調整數量: "quantity_delta", 原因: "reason" };
  const headers = (rows.shift() ?? []).map((value) => aliases[value.trim()] ?? value.trim());
  if (headers.length !== 3 || new Set(headers).size !== 3 || !["item_code", "quantity_delta", "reason"].every((key) => headers.includes(key))) throw new Error("欄位須為 item_code,quantity_delta,reason。");
  if (!rows.length || rows.length > ADJUSTMENT_MAX_LINES) throw new Error("每張調整單須有 1–1000 筆明細。");
  const seen = new Set<string>();
  return rows.map((values, index) => {
    if (values.length !== 3) throw new Error(`第 ${index + 2} 列欄位數錯誤。`);
    const record = Object.fromEntries(headers.map((key, column) => [key, values[column].trim()]));
    if (!record.item_code || !record.reason || record.reason.length > 500 || record.item_code.length > 100 || /^[=+\-@\t\r]/.test(record.item_code) || /^[=+\-@\t\r]/.test(record.reason)) throw new Error(`第 ${index + 2} 列品號或原因無效（不得使用公式）。`);
    if (seen.has(record.item_code)) throw new Error(`第 ${index + 2} 列品號重複。`);
    seen.add(record.item_code);
    return { item_code: record.item_code, quantity_delta: signedAdjustmentQuantity(record.quantity_delta), reason: record.reason };
  });
}

export function adjustmentSampleCsv(codes: readonly string[]): string {
  const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
  return "\uFEFFitem_code,quantity_delta,reason\r\n" + (codes.length ? codes.slice(0, 2) : ["請填入實際品號"]).map((code, index) => `${quote(/^[=+\-@]/.test(code) ? "請填入實際品號" : code)},${index ? -1 : 1},${quote(index ? "減少原因（請修改）" : "增加原因（請修改）")}`).join("\r\n") + "\r\n";
}
