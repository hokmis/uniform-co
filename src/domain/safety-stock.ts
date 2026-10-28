export const SAFETY_STOCK_STORAGE_KEY = "uniform-co:safety-stock-settings";
export const safetyStockChangedEvent = "uniform-co:safety-stock-changed";

export type SafetyStockMap = Record<string, number>;

export interface SafetyStockTarget {
  itemId?: string | null;
  itemCode?: string | null;
}

/**
 * 載入所有已設定之品項安全庫存（自 localStorage）
 * 傳回 key 為 itemId 或 itemCode，值為安全庫存量（正整數）的物件
 */
export function loadSafetyStockMap(): SafetyStockMap {
  if (typeof window === "undefined" || !window.localStorage) {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(SAFETY_STOCK_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};

    const cleanMap: SafetyStockMap = {};
    for (const [key, val] of Object.entries(parsed)) {
      const num = Number(val);
      if (Number.isFinite(num) && num > 0) {
        cleanMap[key] = Math.trunc(num);
      }
    }
    return cleanMap;
  } catch {
    return {};
  }
}

/**
 * 儲存個別品項安全庫存（寫入 localStorage 並廣播事件）
 * 若 quantity 為 null 或 <= 0，代表清除該品項之安全庫存設定
 */
export function saveSafetyStock(itemKey: string, quantity: number | null): void {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }
  try {
    const currentMap = loadSafetyStockMap();
    const cleanKey = itemKey.trim();
    if (!cleanKey) return;

    if (quantity === null || quantity === undefined || Number.isNaN(quantity) || quantity <= 0) {
      delete currentMap[cleanKey];
    } else {
      currentMap[cleanKey] = Math.trunc(quantity);
    }

    window.localStorage.setItem(SAFETY_STOCK_STORAGE_KEY, JSON.stringify(currentMap));

    window.dispatchEvent(
      new CustomEvent(safetyStockChangedEvent, {
        detail: {
          itemKey: cleanKey,
          quantity: currentMap[cleanKey] ?? null,
        },
      }),
    );
  } catch {
    // 忽略 localStorage 寫入錯誤（例如 QuotaExceeded）
  }
}

/**
 * 取得指定品項的安全庫存數值（優先比對 itemId，再比對 itemCode）
 */
export function getSafetyStockThreshold(
  item: SafetyStockTarget,
  map?: SafetyStockMap | null,
): number | null {
  if (!map) return null;
  if (item.itemId && map[item.itemId] !== undefined && map[item.itemId] > 0) {
    return map[item.itemId];
  }
  if (item.itemCode && map[item.itemCode] !== undefined && map[item.itemCode] > 0) {
    return map[item.itemCode];
  }
  return null;
}

/**
 * 判定目前可申請量是否低於安全庫存
 * 當有設定安全庫存且 availableQuantity <= threshold 時判定為 true
 */
export function isBelowSafetyStock(
  availableQuantity: number,
  threshold: number | null | undefined,
): boolean {
  if (threshold === null || threshold === undefined || threshold <= 0) {
    return false;
  }
  return availableQuantity <= threshold;
}
