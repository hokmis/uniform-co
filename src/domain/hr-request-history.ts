export const hrRequestStatuses = [
  "DRAFT",
  "SUBMITTED",
  "INVENTORY_REVIEW_REQUIRED",
  "SHIPPED",
  "CANCELLED",
] as const;

export type HrRequestStatus = (typeof hrRequestStatuses)[number];
export type HrRequestStatusFilter = HrRequestStatus | "ALL";
export type HrRequestHistorySortKey = "request_no" | "distribution_date" | "status" | "row_version";
export type HrRequestHistorySortDirection = "asc" | "desc";

export type HrRequestHistoryRow = {
  id: string;
  requestNo: string;
  status: HrRequestStatus;
  distributionDate: string;
  rowVersion: number;
  createdAt: string;
  submittedAt: string | null;
  shippedAt: string | null;
  cancelledAt: string | null;
  note: string | null;
  shipmentNo: string | null;
  shipmentStatus: "DRAFT" | "POSTED" | null;
  activeReservedQuantity: number;
};

const statusLabels: Record<HrRequestStatus, string> = {
  DRAFT: "草稿",
  SUBMITTED: "待發貨",
  INVENTORY_REVIEW_REQUIRED: "庫存待覆核",
  SHIPPED: "已完成發放",
  CANCELLED: "已取消",
};

export function hrRequestStatusLabel(status: string): string {
  return statusLabels[status as HrRequestStatus] ?? (status || "未知狀態");
}

export function filterHrRequestHistory(
  rows: readonly HrRequestHistoryRow[],
  query: string,
  status: HrRequestStatusFilter,
): HrRequestHistoryRow[] {
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-TW");
  return rows.filter((row) => {
    if (status !== "ALL" && row.status !== status) return false;
    if (!normalizedQuery) return true;
    return [
      row.requestNo,
      row.distributionDate,
      row.note ?? "",
      row.shipmentNo ?? "",
      hrRequestStatusLabel(row.status),
    ].join(" ").toLocaleLowerCase("zh-TW").includes(normalizedQuery);
  });
}

export function sortHrRequestHistory(
  rows: readonly HrRequestHistoryRow[],
  sortKey: HrRequestHistorySortKey,
  direction: HrRequestHistorySortDirection,
): HrRequestHistoryRow[] {
  const factor = direction === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => {
    let result = 0;
    if (sortKey === "distribution_date") {
      result = (Date.parse(left.distributionDate) || 0) - (Date.parse(right.distributionDate) || 0);
    } else if (sortKey === "row_version") {
      result = left.rowVersion - right.rowVersion;
    } else if (sortKey === "status") {
      result = hrRequestStatusLabel(left.status).localeCompare(hrRequestStatusLabel(right.status), "zh-TW");
    } else {
      result = left.requestNo.localeCompare(right.requestNo, "zh-TW", { numeric: true, sensitivity: "base" });
    }
    return (result || left.id.localeCompare(right.id, "en", { numeric: true })) * factor;
  });
}
