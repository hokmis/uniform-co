const terminalImportStatuses = new Set(["APPLIED", "FAILED", "CANCELLED"]);

export function canChangeDurableImportType(
  busy: boolean,
  batchStatus: string | null | undefined,
): boolean {
  return !busy && (!batchStatus || terminalImportStatuses.has(batchStatus));
}

export function formatDurableImportDate(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "時間未取得";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= 0) return "時間未取得";
  return date.toLocaleString("zh-TW");
}

export function formatDurableImportCount(value: unknown): string {
  const count = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(count) ? String(count) : "—";
}
