export type WarehouseShipmentQueueRow = {
  id: string;
  source: "HR_REQUEST" | "REPLENISHMENT";
  requestNo: string;
  distributionDate: string;
  rowVersion: number;
  shipmentStatus: "READY" | "DRAFT" | "POSTED";
  shipmentNo: string | null;
};

export type WarehouseShipmentSortKey = "request_no" | "distribution_date" | "row_version";
export type WarehouseShipmentSortDirection = "asc" | "desc";

export type WarehouseShipmentLineEdit = {
  id: string;
  actual_transfer_quantity: number;
  short_ship_reason_code: string | null;
};

/** Returns only edits that have not reached the persisted shipment draft yet. */
export function changedWarehouseShipmentLines<T extends WarehouseShipmentLineEdit>(
  current: readonly T[],
  persisted: readonly WarehouseShipmentLineEdit[],
): T[] {
  const persistedById = new Map(persisted.map((line) => [line.id, line]));
  return current.filter((line) => {
    const saved = persistedById.get(line.id);
    return !saved
      || saved.actual_transfer_quantity !== line.actual_transfer_quantity
      || saved.short_ship_reason_code !== line.short_ship_reason_code;
  });
}

export function isWarehousePostConfirmed(
  source: "HR_REQUEST" | "REPLENISHMENT",
  expectedId: string,
  result: { id?: unknown; status?: unknown } | null | undefined,
): boolean {
  const expectedStatus = source === "HR_REQUEST" ? "POSTED" : "SHIPPED";
  return result?.id === expectedId && result.status === expectedStatus;
}

export type WarehouseShipmentQueueRefreshState = {
  queueLoading: boolean;
  detailsLoading: boolean;
  busy: boolean;
  draftDirty: boolean;
};

/**
 * A server-backed draft is safe to keep selected while the queue is refreshed.
 * Only an in-flight operation, detail read, or local edits that have not
 * reached the server must block the low-risk list refresh.
 */
export function canRefreshWarehouseShipmentQueue(state: WarehouseShipmentQueueRefreshState): boolean {
  return !state.queueLoading && !state.detailsLoading && !state.busy && !state.draftDirty;
}

export function filterWarehouseShipmentQueue(
  rows: readonly WarehouseShipmentQueueRow[],
  query: string,
): WarehouseShipmentQueueRow[] {
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-TW");
  if (!normalizedQuery) return [...rows];
  return rows.filter((row) => [
    row.source === "REPLENISHMENT" ? "補庫單 額外補庫" : "人資需求單 發貨",
    row.requestNo,
    row.distributionDate,
    row.rowVersion,
    row.shipmentNo ?? "",
    row.shipmentStatus === "DRAFT" ? "已有草稿" : row.shipmentStatus === "POSTED" ? "已完成" : "待建立",
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
