export type SeasonalApprovalQueueRow = {
  id: string;
  campaignNo: string;
  campaignName: string;
  revision: number;
  demandSnapshotHash: string;
  submittedAt: string;
};

export type SeasonalApprovalSortKey = "campaign_no" | "campaign_name" | "revision" | "submitted_at";
export type SeasonalApprovalSortDirection = "asc" | "desc";

export function filterSeasonalApprovalQueue(
  rows: readonly SeasonalApprovalQueueRow[],
  query: string,
): SeasonalApprovalQueueRow[] {
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-TW");
  if (!normalizedQuery) return [...rows];
  return rows.filter((row) => [row.campaignNo, row.campaignName, String(row.revision), row.demandSnapshotHash]
    .join(" ")
    .toLocaleLowerCase("zh-TW")
    .includes(normalizedQuery));
}

export function sortSeasonalApprovalQueue(
  rows: readonly SeasonalApprovalQueueRow[],
  sortKey: SeasonalApprovalSortKey,
  direction: SeasonalApprovalSortDirection,
): SeasonalApprovalQueueRow[] {
  const factor = direction === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => {
    if (sortKey === "revision") {
      const result = left.revision - right.revision;
      if (result !== 0) return result * factor;
    } else if (sortKey === "submitted_at") {
      const result = (Date.parse(left.submittedAt) || 0) - (Date.parse(right.submittedAt) || 0);
      if (result !== 0) return result * factor;
    } else {
      const leftValue = sortKey === "campaign_name" ? left.campaignName : left.campaignNo;
      const rightValue = sortKey === "campaign_name" ? right.campaignName : right.campaignNo;
      const result = leftValue.localeCompare(rightValue, "zh-TW", { numeric: true, sensitivity: "base" });
      if (result !== 0) return result * factor;
    }
    return left.id.localeCompare(right.id, "en", { numeric: true }) * factor;
  });
}
