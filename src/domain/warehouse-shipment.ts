export type WarehouseShipmentQueueRow = {
  id: string;
  requestNo: string;
  distributionDate: string;
  rowVersion: number;
  shipmentStatus: "READY" | "DRAFT" | "POSTED";
  shipmentNo: string | null;
};

export type WarehouseShipmentSortKey = "request_no" | "distribution_date" | "row_version";
export type WarehouseShipmentSortDirection = "asc" | "desc";

export function filterWarehouseShipmentQueue(
  rows: readonly WarehouseShipmentQueueRow[],
  query: string,
): WarehouseShipmentQueueRow[] {
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-TW");
  if (!normalizedQuery) return [...rows];
  return rows.filter((row) => [
    row.requestNo,
    row.distributionDate,
    row.rowVersion,
    row.shipmentNo ?? "",
    row.shipmentStatus === "DRAFT" ? "已有草稿" : row.shipmentStatus === "POSTED" ? "已 POST" : "待建立",
  ].join(" ").toLocaleLowerCase("zh-TW").includes(normalizedQuery));
}

export function sortWarehouseShipmentQueue(
  rows: readonly WarehouseShipmentQueueRow[],
  sortKey: WarehouseShipmentSortKey,
  direction: WarehouseShipmentSortDirection,
): WarehouseShipmentQueueRow[] {
  const factor = direction === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => {
    let result = 0;
    if (sortKey === "row_version") result = left.rowVersion - right.rowVersion;
    else if (sortKey === "distribution_date") result = (Date.parse(left.distributionDate) || 0) - (Date.parse(right.distributionDate) || 0);
    else result = left.requestNo.localeCompare(right.requestNo, "zh-TW", { numeric: true, sensitivity: "base" });
    return (result || left.id.localeCompare(right.id, "en", { numeric: true })) * factor;
  });
}
