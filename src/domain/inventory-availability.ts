export type InventoryAvailabilityRow = {
  itemId: string;
  itemCode: string;
  itemName: string;
  unit: string;
  size: string | null;
  category: string | null;
  season: string | null;
  isActive: boolean;
  hrOnHand: number;
  generalOnHand: number;
  combinedOnHand: number;
  activeReserved: number;
  availableToRequest: number;
};

export type InventoryAvailabilityStatus = "AVAILABLE" | "OUT_OF_STOCK" | "INACTIVE" | "DATA_ERROR";
export type InventoryAvailabilityStatusFilter = "ALL" | InventoryAvailabilityStatus;
export type InventoryAvailabilitySortKey =
  | "item_code"
  | "item_name"
  | "category"
  | "hr_on_hand"
  | "general_on_hand"
  | "combined_on_hand"
  | "active_reserved"
  | "available_to_request"
  | "status";
export type InventoryAvailabilitySortDirection = "asc" | "desc";

export type InventoryAvailabilityFilters = {
  query: string;
  category: string;
  status: InventoryAvailabilityStatusFilter;
};

function textValue(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function nullableTextValue(value: unknown): string | null {
  const text = textValue(value).trim();
  return text || null;
}

function quantityValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

export function normalizeInventoryAvailabilityRow(row: Record<string, unknown>): InventoryAvailabilityRow {
  return {
    itemId: textValue(row.item_id),
    itemCode: textValue(row.item_code),
    itemName: textValue(row.item_name),
    unit: textValue(row.unit),
    size: nullableTextValue(row.size),
    category: nullableTextValue(row.category),
    season: nullableTextValue(row.season),
    isActive: row.is_active === true || row.is_active === "true",
    hrOnHand: quantityValue(row.hr_on_hand_quantity),
    generalOnHand: quantityValue(row.general_on_hand_quantity),
    combinedOnHand: quantityValue(row.combined_on_hand_quantity),
    activeReserved: quantityValue(row.active_reserved_quantity),
    availableToRequest: quantityValue(row.available_to_request_quantity),
  };
}

export function inventoryAvailabilityStatus(row: InventoryAvailabilityRow): InventoryAvailabilityStatus {
  if (!row.isActive) return "INACTIVE";
  if ([row.hrOnHand, row.generalOnHand, row.combinedOnHand, row.activeReserved, row.availableToRequest].some((value) => value < 0)) {
    return "DATA_ERROR";
  }
  return row.availableToRequest > 0 ? "AVAILABLE" : "OUT_OF_STOCK";
}

export function inventoryAvailabilityStatusLabel(status: InventoryAvailabilityStatus): string {
  const labels: Record<InventoryAvailabilityStatus, string> = {
    AVAILABLE: "可申請",
    OUT_OF_STOCK: "無可申請量",
    INACTIVE: "已停用",
    DATA_ERROR: "資料異常",
  };
  return labels[status];
}

export function inventoryAvailabilityCategories(rows: readonly InventoryAvailabilityRow[]): string[] {
  return [...new Set(rows.map((row) => row.category?.trim()).filter((value): value is string => Boolean(value)))]
    .sort((left, right) => left.localeCompare(right, "zh-TW", { numeric: true }));
}

export function filterInventoryAvailability(
  rows: readonly InventoryAvailabilityRow[],
  filters: InventoryAvailabilityFilters,
): InventoryAvailabilityRow[] {
  const query = filters.query.trim().toLocaleLowerCase("zh-TW");
  return rows.filter((row) => {
    const status = inventoryAvailabilityStatus(row);
    if (filters.status !== "ALL" && status !== filters.status) return false;
    if (filters.category !== "ALL" && row.category !== filters.category) return false;
    if (!query) return true;
    return [row.itemCode, row.itemName, row.size, row.category, row.season, row.unit]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase("zh-TW")
      .includes(query);
  });
}

export function sortInventoryAvailability(
  rows: readonly InventoryAvailabilityRow[],
  sortKey: InventoryAvailabilitySortKey,
  direction: InventoryAvailabilitySortDirection,
): InventoryAvailabilityRow[] {
  const factor = direction === "asc" ? 1 : -1;
  const numericValues: Partial<Record<InventoryAvailabilitySortKey, (row: InventoryAvailabilityRow) => number>> = {
    hr_on_hand: (row) => row.hrOnHand,
    general_on_hand: (row) => row.generalOnHand,
    combined_on_hand: (row) => row.combinedOnHand,
    active_reserved: (row) => row.activeReserved,
    available_to_request: (row) => row.availableToRequest,
  };
  const numericValue = numericValues[sortKey];
  function textSortValue(row: InventoryAvailabilityRow): string {
    if (sortKey === "item_name") return row.itemName;
    if (sortKey === "category") return row.category ?? "";
    if (sortKey === "status") return inventoryAvailabilityStatusLabel(inventoryAvailabilityStatus(row));
    return row.itemCode;
  }
  return [...rows].sort((left, right) => {
    if (numericValue) return (numericValue(left) - numericValue(right)) * factor;
    return textSortValue(left).localeCompare(textSortValue(right), "zh-TW", { numeric: true }) * factor;
  });
}
