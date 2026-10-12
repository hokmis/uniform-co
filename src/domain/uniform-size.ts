import {
  ORDERED_ITEM_CATEGORIES,
  getItemCategoryRank,
  getBaseItemName,
  getItemGender,
} from "./hr-request-pivot-export";

/**
 * 使用者指定之標準尺寸清單與排序順序：
 * "XS"、"S"、"M"、"L"、"XL"、"2L"、"3L"、"4L"、"5L"、"6L"
 */
export const STANDARD_UNIFORM_SIZES = [
  "XS",
  "S",
  "M",
  "L",
  "XL",
  "2L",
  "3L",
  "4L",
  "5L",
  "6L",
] as const;

export type StandardUniformSize = typeof STANDARD_UNIFORM_SIZES[number];

export const UNIFORM_SIZE_ORDER_MAP: Record<string, number> = {
  "4XS": 1,
  "3XS": 2,
  "XXXS": 2,
  "2XS": 3,
  "XXS": 3,
  "XS": 4,
  "S": 10,
  "M": 20,
  "L": 30,
  "XL": 40,
  "1L": 40,
  "2L": 50,
  "XXL": 50,
  "2XL": 50,
  "3L": 60,
  "XXXL": 60,
  "3XL": 60,
  "4L": 70,
  "4XL": 70,
  "5L": 80,
  "5XL": 80,
  "6L": 90,
  "6XL": 90,
  "7L": 100,
  "7XL": 100,
  "8L": 110,
  "9L": 120,
  "10L": 130,
  "F": 200,
  "FREE": 200,
};

/**
 * 從品項規格或品名解析標準化尺寸代碼（例如 "XS", "S", "M", "L", "XL", "2L", "3L", "4L", "5L", "6L"）
 */
export function extractUniformSize(size?: string | null, itemName?: string | null): string {
  const rawSize = (size ?? "").trim();
  if (rawSize) {
    const cleaned = rawSize.replace(/^[男女\-\s]+/, "").trim().toUpperCase();
    if (cleaned) return cleaned;
  }
  const name = (itemName ?? "").trim();
  const match = name.match(/-[男女]?([A-Za-z0-9]+)$/);
  if (match) {
    return match[1].toUpperCase();
  }
  return rawSize.toUpperCase();
}

/**
 * 取得尺碼排序權重：
 * XS (4) < S (10) < M (20) < L (30) < XL (40) < 2L (50) < 3L (60) < 4L (70) < 5L (80) < 6L (90)
 */
export function getUniformSizeRank(size?: string | null, itemName?: string | null): number {
  const s = extractUniformSize(size, itemName);
  if (!s) return 999;
  if (UNIFORM_SIZE_ORDER_MAP[s] !== undefined) {
    return UNIFORM_SIZE_ORDER_MAP[s];
  }
  const lMatch = s.match(/^(\d+)L$/);
  if (lMatch) {
    return parseInt(lMatch[1], 10) * 10 + 30;
  }
  const numMatch = s.match(/^(\d+)$/);
  if (numMatch) {
    return 300 + parseInt(numMatch[1], 10);
  }
  return 900;
}

export type SortableUniformItem = {
  itemCode: string;
  itemName: string;
  size?: string | null;
};

/**
 * 制服品項排序比較函式：
 * 1. 大類別排序（照服夏季 -> 照服冬季 -> ...）
 * 2. 基礎品名（同款式集中）
 * 3. 性別（女款先於男款）
 * 4. 尺碼順序（XS < S < M < L < XL < 2L < 3L < 4L < 5L < 6L）
 * 5. 品號備用排序
 */
export function compareUniformItems<T extends SortableUniformItem>(a: T, b: T): number {
  const catRankA = getItemCategoryRank(a.itemName, a.itemCode);
  const catRankB = getItemCategoryRank(b.itemName, b.itemCode);
  if (catRankA !== catRankB) return catRankA - catRankB;

  const baseA = getBaseItemName(a.itemName || a.itemCode, a.size ?? undefined);
  const baseB = getBaseItemName(b.itemName || b.itemCode, b.size ?? undefined);
  const baseCmp = baseA.localeCompare(baseB, "zh-TW", { numeric: true });
  if (baseCmp !== 0) return baseCmp;

  const genderA = getItemGender(a.itemName, a.size ?? undefined);
  const genderB = getItemGender(b.itemName, b.size ?? undefined);
  const genderCmp = genderA.localeCompare(genderB, "zh-TW");
  if (genderCmp !== 0) return genderCmp;

  const rankA = getUniformSizeRank(a.size, a.itemName);
  const rankB = getUniformSizeRank(b.size, b.itemName);
  if (rankA !== rankB) return rankA - rankB;

  return (a.itemCode || "").localeCompare(b.itemCode || "", "zh-TW", { numeric: true });
}
