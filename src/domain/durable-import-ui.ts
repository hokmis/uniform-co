const terminalImportStatuses = new Set(["APPLIED", "FAILED", "CANCELLED"]);
const processingImportStatuses = new Set(["AWAITING_UPLOAD", "UPLOADED", "PARSING", "VALIDATING", "APPLYING"]);
const rowVisibleImportStatuses = new Set(["VALIDATED", "FAILED"]);

type DurableImportPreviewDifference = {
  field_name: string;
  old_value: unknown;
  new_value: unknown;
  confirmed: boolean;
};

type DurableImportPreviewRow = {
  row_number: number;
  validation_errors: unknown;
  import_field_diffs?: readonly DurableImportPreviewDifference[] | null;
};

export type DurableImportPreviewSummary = {
  validationErrorRows: DurableImportPreviewRow[];
  visibleUnconfirmedDifferences: DurableImportPreviewDifference[];
  unconfirmedDifferenceCount: number;
};

export function summarizeDurableImportPreview(rows: readonly DurableImportPreviewRow[]): DurableImportPreviewSummary {
  const validationErrorRows: DurableImportPreviewRow[] = [];
  const visibleUnconfirmedDifferences: DurableImportPreviewDifference[] = [];
  let unconfirmedDifferenceCount = 0;

  for (const row of rows) {
    if (Array.isArray(row.validation_errors) && row.validation_errors.length > 0 && validationErrorRows.length < 10) {
      validationErrorRows.push(row);
    }
    for (const difference of row.import_field_diffs ?? []) {
      if (difference.confirmed) continue;
      unconfirmedDifferenceCount += 1;
      if (visibleUnconfirmedDifferences.length < 10) visibleUnconfirmedDifferences.push(difference);
    }
  }

  return { validationErrorRows, visibleUnconfirmedDifferences, unconfirmedDifferenceCount };
}

export function isDurableImportTerminalStatus(status: string | null | undefined): boolean {
  return typeof status === "string" && terminalImportStatuses.has(status);
}

export function isDurableImportProcessingStatus(status: string | null | undefined): boolean {
  return typeof status === "string" && processingImportStatuses.has(status);
}

export function isDurableImportRowsVisibleStatus(status: string | null | undefined): boolean {
  return typeof status === "string" && rowVisibleImportStatuses.has(status);
}

export function isDurableImportAwaitingUpload(status: string | null | undefined): boolean {
  return status === "AWAITING_UPLOAD";
}

export function canChangeDurableImportType(
  busy: boolean,
  batchStatus: string | null | undefined,
): boolean {
  return !busy && (!batchStatus || isDurableImportTerminalStatus(batchStatus));
}

export function isDurableImportObjectAlreadyUploaded(
  error: { message?: string | null; statusCode?: number | string | null } | null | undefined,
): boolean {
  if (!error) return false;
  if (String(error.statusCode ?? "") === "409") return true;
  return error.message?.toLowerCase().includes("resource already exists") ?? false;
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
