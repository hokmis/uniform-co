export type CorrectionHistoryRow = {
  id: string;
  correctionNo: string;
  status: string;
  reason: string;
  deltaText: string;
  postedAt: string | null;
};

export type CorrectionHistorySortKey = "correction_no" | "status" | "delta" | "reason" | "posted_at";
export type CorrectionHistorySortDirection = "asc" | "desc";

export const ALL_CORRECTION_HISTORY_STATUSES = "ALL";

export function correctionHistoryStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    DRAFT: "草稿",
    POSTED: "已過帳",
    CANCELLED: "已取消",
  };
  return labels[status] ?? status;
}

export function correctionHistoryStatuses(rows: readonly CorrectionHistoryRow[]): string[] {
  const preferred = ["DRAFT", "POSTED", "CANCELLED"];
  const available = new Set(rows.map((row) => row.status).filter(Boolean));
  const known = preferred.filter((status) => available.has(status));
  const unknown = [...available]
    .filter((status) => !preferred.includes(status))
    .sort((left, right) => left.localeCompare(right, "zh-TW", { numeric: true }));
  return [...known, ...unknown];
}

export function filterCorrectionHistory(
  rows: readonly CorrectionHistoryRow[],
  query: string,
  status: string,
): CorrectionHistoryRow[] {
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-TW");
  return rows.filter((row) => {
    if (status !== ALL_CORRECTION_HISTORY_STATUSES && row.status !== status) return false;
    if (!normalizedQuery) return true;
    return [
      row.correctionNo,
      row.status,
      correctionHistoryStatusLabel(row.status),
      row.reason,
      row.deltaText,
      row.postedAt ?? "",
    ]
      .join(" ")
      .toLocaleLowerCase("zh-TW")
      .includes(normalizedQuery);
  });
}

export function sortCorrectionHistory(
  rows: readonly CorrectionHistoryRow[],
  sortKey: CorrectionHistorySortKey,
  direction: CorrectionHistorySortDirection,
): CorrectionHistoryRow[] {
  const factor = direction === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => {
    const leftValue = correctionHistorySortValue(left, sortKey);
    const rightValue = correctionHistorySortValue(right, sortKey);
    const primary = leftValue.localeCompare(rightValue, "zh-TW", { numeric: true, sensitivity: "base" });
    if (primary !== 0) return primary * factor;
    return left.id.localeCompare(right.id, "en", { numeric: true }) * factor;
  });
}

function correctionHistorySortValue(row: CorrectionHistoryRow, sortKey: CorrectionHistorySortKey): string {
  if (sortKey === "status") {
    const workflowRank = ["DRAFT", "POSTED", "CANCELLED"].indexOf(row.status);
    return `${workflowRank < 0 ? 99 : workflowRank}-${correctionHistoryStatusLabel(row.status)}`;
  }
  if (sortKey === "delta") return row.deltaText;
  if (sortKey === "reason") return row.reason;
  if (sortKey === "posted_at") return row.postedAt ?? "";
  return row.correctionNo;
}
