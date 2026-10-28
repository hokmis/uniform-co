import { isSupabaseSessionSyncError } from "../lib/supabase-session";

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

export type InventoryAvailabilityStatus =
  | "AVAILABLE"
  | "OUT_OF_STOCK"
  | "GENERAL_OUT_OF_STOCK"
  | "BELOW_SAFETY_STOCK"
  | "INACTIVE"
  | "DATA_ERROR";
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
  | "safety_stock"
  | "status";
export type InventoryAvailabilitySortDirection = "asc" | "desc";

export type InventoryAvailabilityFilters = {
  query: string;
  category: string;
  status: InventoryAvailabilityStatusFilter;
  safetyStockMap?: Record<string, number>;
};

type InventoryAvailabilityError = {
  code?: string | null;
  message?: string | null;
};

/**
 * Supabase may briefly reject a read while the browser session is being
 * refreshed. Keep this classification narrow so ordinary RLS/schema errors
 * are not retried or exposed to the user as raw database messages.
 */
export function isInventoryAvailabilitySessionSyncError(
  error: InventoryAvailabilityError | null | undefined,
): boolean {
  return isSupabaseSessionSyncError(error);
}

export function inventoryAvailabilityLoadErrorMessage(
  error: InventoryAvailabilityError | null | undefined,
): string {
  if (isInventoryAvailabilitySessionSyncError(error)) {
    return "登入狀態尚未同步，已重新整理登入狀態；請按「重新整理」再試。";
  }
  return "庫存清單暫時無法載入，請按「重新整理」再試。";
}

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

export function inventoryAvailabilityStatus(
  row: InventoryAvailabilityRow,
  safetyStock?: number | null,
): InventoryAvailabilityStatus {
  if (!row.isActive) return "INACTIVE";
  if ([row.hrOnHand, row.generalOnHand, row.combinedOnHand, row.activeReserved, row.availableToRequest].some((value) => value < 0)) {
    return "DATA_ERROR";
  }
  if (row.availableToRequest <= 0) return "OUT_OF_STOCK";
  if (safetyStock !== null && safetyStock !== undefined && safetyStock > 0 && row.availableToRequest <= safetyStock) {
    return "BELOW_SAFETY_STOCK";
  }
  if (row.generalOnHand <= 0) return "GENERAL_OUT_OF_STOCK";
  return "AVAILABLE";
}

export function inventoryAvailabilityStatusLabel(status: InventoryAvailabilityStatus): string {
  const labels: Record<InventoryAvailabilityStatus, string> = {
    AVAILABLE: "可申請",
    OUT_OF_STOCK: "無可申請量",
    GENERAL_OUT_OF_STOCK: "總倉無庫存",
    BELOW_SAFETY_STOCK: "低於安全庫存",
    INACTIVE: "已停用",
    DATA_ERROR: "資料異常",
  };
  return labels[status] ?? "";
}

/**
 * 判定品項是否為需注意品項（缺貨、總倉無庫存、低於安全庫存、資料異常）
 */
export function isInventoryAttentionRequired(
  row: InventoryAvailabilityRow,
  safetyStock?: number | null,
): boolean {
  const status = inventoryAvailabilityStatus(row, safetyStock);
  return ["OUT_OF_STOCK", "GENERAL_OUT_OF_STOCK", "BELOW_SAFETY_STOCK", "DATA_ERROR"].includes(status);
}

/**
 * 計算指定清單中需注意品項總數
 */
export function countInventoryAttentionRows(
  rows: readonly InventoryAvailabilityRow[],
  safetyStockMap?: Record<string, number>,
): number {
  return rows.filter((row) => {
    const threshold = safetyStockMap
      ? (safetyStockMap[row.itemCode] ?? (row.itemId ? safetyStockMap[row.itemId] : undefined) ?? null)
      : null;
    return isInventoryAttentionRequired(row, threshold);
  }).length;
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
    const safetyStock = filters.safetyStockMap
      ? (filters.safetyStockMap[row.itemId] ?? filters.safetyStockMap[row.itemCode] ?? null)
      : null;
    const status = inventoryAvailabilityStatus(row, safetyStock);
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
  safetyStockMap?: Record<string, number>,
): InventoryAvailabilityRow[] {
  const factor = direction === "asc" ? 1 : -1;
  const numericValues: Partial<Record<InventoryAvailabilitySortKey, (row: InventoryAvailabilityRow) => number>> = {
    hr_on_hand: (row) => row.hrOnHand,
    general_on_hand: (row) => row.generalOnHand,
    combined_on_hand: (row) => row.combinedOnHand,
    active_reserved: (row) => row.activeReserved,
    available_to_request: (row) => row.availableToRequest,
    safety_stock: (row) => {
      const val = safetyStockMap ? (safetyStockMap[row.itemId] ?? safetyStockMap[row.itemCode]) : undefined;
      return val ?? 0;
    },
  };
  const numericValue = numericValues[sortKey];
  function textSortValue(row: InventoryAvailabilityRow): string {
    if (sortKey === "item_name") return row.itemName;
    if (sortKey === "category") return row.category ?? "";
    if (sortKey === "status") {
      const safetyStock = safetyStockMap
        ? (safetyStockMap[row.itemId] ?? safetyStockMap[row.itemCode] ?? null)
        : null;
      return inventoryAvailabilityStatusLabel(inventoryAvailabilityStatus(row, safetyStock));
    }
    return row.itemCode;
  }
  return [...rows].sort((left, right) => {
    if (numericValue) return (numericValue(left) - numericValue(right)) * factor;
    return textSortValue(left).localeCompare(textSortValue(right), "zh-TW", { numeric: true }) * factor;
  });
}
