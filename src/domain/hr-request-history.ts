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

export type HrRequestDateRange = {
  startDate?: string;
  endDate?: string;
};

export function getDefaultHrRequestDateRange(now: Date = new Date()): { startDate: string; endDate: string } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(now);
  const yearStr = parts.find((p) => p.type === "year")?.value ?? "2026";
  const monthStr = parts.find((p) => p.type === "month")?.value ?? "10";
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);

  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;
  const startDate = `${prevYear}-${String(prevMonth).padStart(2, "0")}-21`;
  const endDate = `${year}-${String(month).padStart(2, "0")}-20`;

  return { startDate, endDate };
}

export function filterHrRequestHistory(
  rows: readonly HrRequestHistoryRow[],
  query: string,
  status: HrRequestStatusFilter,
  dateFilter?: string | HrRequestDateRange,
  endDateParam?: string,
): HrRequestHistoryRow[] {
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-TW");

  let startDate = "";
  let endDate = "";
  let monthFilter = "";

  if (typeof dateFilter === "object" && dateFilter !== null) {
    startDate = (dateFilter.startDate || "").trim();
    endDate = (dateFilter.endDate || "").trim();
  } else if (typeof dateFilter === "string") {
    const trimmed = dateFilter.trim();
    if (endDateParam !== undefined) {
      startDate = trimmed;
      endDate = (endDateParam || "").trim();
    } else if (trimmed.length === 7 && trimmed.includes("-")) {
      monthFilter = trimmed;
    } else if (trimmed) {
      startDate = trimmed;
    }
  }

  return rows.filter((row) => {
    if (status !== "ALL" && row.status !== status) return false;
    const rowDate = row.distributionDate || (row.createdAt ? row.createdAt.slice(0, 10) : "");
    if (startDate && rowDate && rowDate < startDate) {
      return false;
    }
    if (endDate && rowDate && rowDate > endDate) {
      return false;
    }
    if (monthFilter && monthFilter !== "ALL") {
      const distMonth = (row.distributionDate || "").slice(0, 7);
      const createdMonth = (row.createdAt || "").slice(0, 7);
      if (distMonth !== monthFilter && createdMonth !== monthFilter) {
        return false;
      }
    }
    if (!normalizedQuery) return true;
    const querySlashNormalized = normalizedQuery.replace(/\//g, "-");
    const searchableText = [
      row.requestNo,
      row.distributionDate,
      (row.distributionDate || "").replace(/-/g, "/"),
      row.note ?? "",
      row.shipmentNo ?? "",
      hrRequestStatusLabel(row.status),
    ].join(" ").toLocaleLowerCase("zh-TW");
    return searchableText.includes(normalizedQuery) || searchableText.includes(querySlashNormalized);
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
