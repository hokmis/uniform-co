export type SeasonalDemandQueueRow = {
  id: string;
  employeeNo: string;
  employeeName: string;
  itemCode: string;
  itemName: string;
  size: string | null;
  quantity: number;
  updatedAt: string;
  hrModified: boolean;
};

export type SeasonalDemandSortKey = "employee_no" | "employee_name" | "item_code" | "quantity" | "updated_at";
export type SeasonalDemandSortDirection = "asc" | "desc";

export function filterSeasonalDemandQueue(
  rows: readonly SeasonalDemandQueueRow[],
  query: string,
): SeasonalDemandQueueRow[] {
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-TW");
  if (!normalizedQuery) return [...rows];
  return rows.filter((row) => [
    row.employeeNo,
    row.employeeName,
    row.itemCode,
    row.itemName,
    row.size ?? "",
    row.quantity,
    row.hrModified ? "HR 已修改" : "已登記",
  ].join(" ").toLocaleLowerCase("zh-TW").includes(normalizedQuery));
}

export function sortSeasonalDemandQueue(
  rows: readonly SeasonalDemandQueueRow[],
  sortKey: SeasonalDemandSortKey,
  direction: SeasonalDemandSortDirection,
): SeasonalDemandQueueRow[] {
  const factor = direction === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => {
    let result = 0;
    if (sortKey === "quantity") result = left.quantity - right.quantity;
    else if (sortKey === "updated_at") result = (Date.parse(left.updatedAt) || 0) - (Date.parse(right.updatedAt) || 0);
    else {
      const leftValue = sortKey === "employee_no" ? left.employeeNo : sortKey === "employee_name" ? left.employeeName : left.itemCode;
      const rightValue = sortKey === "employee_no" ? right.employeeNo : sortKey === "employee_name" ? right.employeeName : right.itemCode;
      result = leftValue.localeCompare(rightValue, "zh-TW", { numeric: true, sensitivity: "base" });
    }
    return (result || left.id.localeCompare(right.id, "en", { numeric: true })) * factor;
  });
}
