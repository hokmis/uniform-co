export type ProcurementReason = {
  code: string;
  name: string;
  is_active: boolean;
};

export type ProcurementReasonStatusFilter = "ALL" | "ACTIVE" | "INACTIVE";
export type ProcurementReasonSortKey = "code" | "name" | "status";
export type ProcurementReasonSortDirection = "asc" | "desc";

export function filterProcurementReasons(
  rows: readonly ProcurementReason[],
  query: string,
  status: ProcurementReasonStatusFilter,
): ProcurementReason[] {
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-TW");
  return rows.filter((row) => {
    if (status === "ACTIVE" && !row.is_active) return false;
    if (status === "INACTIVE" && row.is_active) return false;
    if (!normalizedQuery) return true;
    return `${row.code} ${row.name}`.toLocaleLowerCase("zh-TW").includes(normalizedQuery);
  });
}

export function sortProcurementReasons(
  rows: readonly ProcurementReason[],
  sortKey: ProcurementReasonSortKey,
  direction: ProcurementReasonSortDirection,
): ProcurementReason[] {
  const factor = direction === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => {
    const leftValue = sortKey === "status" ? (left.is_active ? "啟用" : "停用") : left[sortKey];
    const rightValue = sortKey === "status" ? (right.is_active ? "啟用" : "停用") : right[sortKey];
    return leftValue.localeCompare(rightValue, "zh-TW", { numeric: true }) * factor;
  });
}
