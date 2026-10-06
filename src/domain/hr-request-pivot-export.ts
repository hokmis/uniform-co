/**
 * 人資需求單二維交叉領用與庫增量統計表 (Excel OpenXML) 匯出服務
 * 支援分店領用數量交叉統計、隨單增庫、額外補庫 (庫增量 F) 與動態合計列
 */
import { zipSync, strToU8 } from "fflate";

export const ORDERED_INSTITUTION_NAMES = [
  "福", "氣", "心", "平", "安",
  "春", "日", "照", "風", "景",
  "山", "泉", "水", "清", "涼",
  "護家", "含笑", "法人", "一館", "二館", "三館", "幼"
] as const;

export type OrderedInstitutionName = typeof ORDERED_INSTITUTION_NAMES[number];

/**
 * 允許抓取的 22 個指定機構單位白名單（其他單位均不抓取）
 */
export const ALLOWED_INSTITUTION_NAMES = new Set<string>(ORDERED_INSTITUTION_NAMES);

/**
 * 分店代碼與簡稱對照表
 */
export const INSTITUTION_CODE_MAP: Record<string, { shortName: OrderedInstitutionName; code: string }> = {
  // C 棟
  "C8": { shortName: "福", code: "C8" },
  "8C": { shortName: "福", code: "C8" },
  "C7": { shortName: "氣", code: "C7" },
  "7C": { shortName: "氣", code: "C7" },
  "C6": { shortName: "心", code: "C6" },
  "6C": { shortName: "心", code: "C6" },
  "C5": { shortName: "平", code: "C5" },
  "5C": { shortName: "平", code: "C5" },
  "C3": { shortName: "安", code: "C3" },
  "3C": { shortName: "安", code: "C3" },
  // D 棟
  "D8": { shortName: "春", code: "D8" },
  "8D": { shortName: "春", code: "D8" },
  "D7": { shortName: "日", code: "D7" },
  "7D": { shortName: "日", code: "D7" },
  "D6": { shortName: "照", code: "D6" },
  "6D": { shortName: "照", code: "D6" },
  "D5": { shortName: "風", code: "D5" },
  "5D": { shortName: "風", code: "D5" },
  "D3": { shortName: "景", code: "D3" },
  "3D": { shortName: "景", code: "D3" },
  // E 棟 / 其他機構
  "E8": { shortName: "山", code: "E8" },
  "8E": { shortName: "山", code: "E8" },
  "E7": { shortName: "泉", code: "E7" },
  "7E": { shortName: "泉", code: "E7" },
  "E6": { shortName: "水", code: "E6" },
  "6E": { shortName: "水", code: "E6" },
  "E5": { shortName: "清", code: "E5" },
  "5E": { shortName: "清", code: "E5" },
  "E3": { shortName: "涼", code: "E3" },
  "3E": { shortName: "涼", code: "E3" },
  "CD2": { shortName: "護家", code: "CD2" },
  "2CD": { shortName: "護家", code: "CD2" },
  // 法人／會館／園區
  "7091980": { shortName: "含笑", code: "7091980" },
  "47091980": { shortName: "含笑", code: "7091980" },
  "L1": { shortName: "法人", code: "L1" },
  "L67": { shortName: "一館", code: "L67" },
  "L5": { shortName: "二館", code: "L5" },
  "L23": { shortName: "三館", code: "L23" },
  "L2B3": { shortName: "三館", code: "L23" },
  "B2": { shortName: "幼", code: "B2" },
};

/**
 * 將機構代碼或名稱正規化至指定簡稱
 */
export function resolveInstitutionInfo(rawCodeOrName: string | null | undefined): { shortName: string; code: string } {
  if (!rawCodeOrName) return { shortName: "其他", code: "" };
  const trimmed = rawCodeOrName.trim();
  
  // 1. 直接由代碼命中
  const upper = trimmed.toUpperCase();
  if (INSTITUTION_CODE_MAP[upper]) {
    return INSTITUTION_CODE_MAP[upper];
  }

  // 2. 由包含的關鍵字命中
  if (trimmed.includes("護家") || trimmed.includes("清護") || trimmed.includes("2CD")) return { shortName: "護家", code: "CD2" };
  if (trimmed.includes("含笑") || trimmed.includes("47091980")) return { shortName: "含笑", code: "47091980" };
  if (trimmed.includes("幼兒園") || trimmed.includes("幼") || trimmed.includes("B2")) return { shortName: "幼", code: "B2" };
  if (trimmed.includes("一館") || trimmed.includes("L67")) return { shortName: "一館", code: "L67" };
  if (trimmed.includes("二館") || trimmed.includes("L5")) return { shortName: "二館", code: "L5" };
  if (trimmed.includes("三館") || trimmed.includes("L23")) return { shortName: "三館", code: "L23" };
  if (trimmed.includes("法人") || trimmed.includes("L1")) return { shortName: "法人", code: "L1" };

  // 3. 由 22 個簡稱之一命中（例如「8C清福」包含「福」）
  for (const name of ORDERED_INSTITUTION_NAMES) {
    if (trimmed.includes(name)) {
      const matchedEntry = Object.values(INSTITUTION_CODE_MAP).find((entry) => entry.shortName === name);
      return { shortName: name, code: matchedEntry?.code ?? "" };
    }
  }

  return { shortName: trimmed, code: trimmed };
}

/**
 * 依據品名與規格解析性別標記 ("男" | "女" | "")
 */
export function getItemGender(itemName: string, size?: string): "男" | "女" | "" {
  const s = size ? size.trim() : "";
  const name = itemName ? itemName.trim() : "";

  // 1. 優先從規格判斷 (例如 "女M", "男L", "男", "女")
  const sHasMale = s.includes("男");
  const sHasFemale = s.includes("女");
  if (sHasMale && !sHasFemale) return "男";
  if (sHasFemale && !sHasMale) return "女";

  // 2. 從品名判斷 (例如 "照服中高階夏上衣(男)", "照服中高階夏上衣-女M", "司機冬季男長褲")
  const nameHasMale = name.includes("男");
  const nameHasFemale = name.includes("女");
  if (nameHasMale && !nameHasFemale) return "男";
  if (nameHasFemale && !nameHasMale) return "女";

  return "";
}

/**
 * 依據品名與規格解析基礎品項名稱，用於判斷是否更換品項
 * 包含：品項名稱不同算換品項、同一品項中男女款切換亦算換品項並加入底端雙框線
 * 範例：
 * "照服夏季上衣-6L" -> "照服夏季上衣"
 * "照服冬季上衣-XS" -> "照服冬季上衣"
 * "照服行政冬夏褲-6L" -> "照服行政冬夏褲"
 * "照服中高階夏上衣-女M" -> "照服中高階夏上衣-女"
 * "照服中高階夏上衣-男L" -> "照服中高階夏上衣-男"
 */
export function getItemCategory(itemName: string, size?: string): string {
  if (!itemName) return "";
  const trimmed = itemName.trim();
  const gender = getItemGender(trimmed, size);

  let base = trimmed;
  if (size && size.trim() && trimmed.endsWith(`-${size.trim()}`)) {
    base = trimmed.slice(0, -(size.trim().length + 1)).trim();
  } else {
    const match = trimmed.match(/^(.*?)(?:-[A-Za-z0-9\u4e00-\u9fa5]+)$/);
    if (match && match[1]) {
      base = match[1].trim();
    }
  }

  // 若具有男女區分，確保分類名稱中包含性別（若原基礎品名未包含，則附加性別）
  if (gender) {
    if (!base.includes("男") && !base.includes("女")) {
      return `${base}-${gender}`;
    }
    return base;
  }

  return base;
}

export type RawIssueLineInput = {
  itemCode: string;
  itemName: string;
  size: string;
  unit?: string;
  institutionCodeOrName: string;
  quantity: number;
};

export type ItemStockInfo = {
  itemCode: string;
  itemName?: string;
  size?: string;
  unit?: string;
  onHand?: number;
  increaseQuantity?: number;
};

export type PivotRow = {
  itemCode: string;
  itemName: string;
  size: string;
  unit: string;
  onHand: number;
  quantitiesByInstitution: Record<string, number>;
  totalIssued: number;
  increaseQuantity: number;
};

export type PivotTableData = {
  institutions: Array<{ shortName: string; code: string }>;
  rows: PivotRow[];
  totalByInstitution: Record<string, number>;
  grandTotal: number;
};

/**
 * 解析尺碼大小權重，實現標準尺碼由小到大排序：
 * XXS < XS < S < M < L < XL < 2L < 3L < 4L < 5L < 6L < 7L < 8L < ... < F
 * 數字尺碼（如長褲腰圍 28, 30, 32...）亦按數字大小排序
 */
export function getSizeRank(sizeStr: string): number {
  if (!sizeStr) return 999;
  let s = sizeStr.trim().toUpperCase();
  s = s.replace(/^[男女\-\s]+/, "").trim();

  const standardSizeMap: Record<string, number> = {
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
    "8XL": 110,
    "9L": 120,
    "9XL": 120,
    "10L": 130,
    "10XL": 130,
    "F": 200,
    "FREE": 200,
  };

  if (standardSizeMap[s] !== undefined) {
    return standardSizeMap[s];
  }

  // 嘗試解析像 "2L"、"3L" 但未在 map 中命中的特殊數字L
  const lMatch = s.match(/^(\d+)L$/);
  if (lMatch) {
    const n = parseInt(lMatch[1], 10);
    return n * 10 + 30; // 2L -> 50, 3L -> 60, 4L -> 70, etc.
  }

  // 嘗試解析純數字尺碼（如長褲腰圍 26, 28, 30, 32...）
  const numMatch = s.match(/^(\d+)$/);
  if (numMatch) {
    return 300 + parseInt(numMatch[1], 10);
  }

  return 500;
}

/**
 * 依據品名與規格解析基礎品名（不含性別與尺碼後綴）
 * 範例：
 * "工務冬季上衣-2L" -> "工務冬季上衣"
 * "行政冬季上衣-女2L" -> "行政冬季上衣"
 * "照服中高階夏上衣-女M" -> "照服中高階夏上衣"
 * "幼兒園夏季上衣-XS" -> "幼兒園夏季上衣"
 */
export function getBaseItemName(itemName: string, size?: string): string {
  if (!itemName) return "";
  let trimmed = itemName.trim();

  // 1. 若規格明確匹配結尾
  if (size && size.trim()) {
    const s = size.trim();
    if (trimmed.endsWith(`-${s}`)) {
      trimmed = trimmed.slice(0, -(s.length + 1)).trim();
    }
  }

  // 2. 移除結尾的 "-[男女]?尺碼" (例如 -女2L, -男XL, -2L, -XS, -女M, -6L)
  trimmed = trimmed.replace(/-[男女]?[A-Za-z0-9\u4e00-\u9fa5]+$/, "").trim();

  return trimmed;
}

/**
 * 依據品名連帶品號排序資料列，將相同類似的品名排列在一起，
 * 並依尺碼由小至大（S, M, L, XL, 2L, 3L, 4L, 5L, 6L...）順序排列
 */
export function comparePivotRows(a: PivotRow, b: PivotRow): number {
  // 1. 基礎品名排序（例如：工務冬季上衣、幼兒園夏季上衣、行政冬季上衣）
  const baseA = getBaseItemName(a.itemName || a.itemCode, a.size);
  const baseB = getBaseItemName(b.itemName || b.itemCode, b.size);
  const baseCmp = baseA.localeCompare(baseB, "zh-TW", { numeric: true });
  if (baseCmp !== 0) return baseCmp;

  // 2. 性別排序：女款先於男款（例如：行政冬季上衣-女 在 行政冬季上衣-男 之前）
  const genderA = getItemGender(a.itemName, a.size);
  const genderB = getItemGender(b.itemName, b.size);
  const genderCmp = genderA.localeCompare(genderB, "zh-TW");
  if (genderCmp !== 0) return genderCmp;

  // 3. 尺碼順序排序：由小至大（S < M < L < XL < 2L < 3L < 4L < 5L < 6L）
  const sizeStrA = a.size || (a.itemName.match(/-([男女]?[A-Za-z0-9]+)$/)?.[1] ?? "");
  const sizeStrB = b.size || (b.itemName.match(/-([男女]?[A-Za-z0-9]+)$/)?.[1] ?? "");
  const rankA = getSizeRank(sizeStrA);
  const rankB = getSizeRank(sizeStrB);
  if (rankA !== rankB) return rankA - rankB;

  // 4. 品號排序
  const codeCmp = (a.itemCode || "").trim().localeCompare((b.itemCode || "").trim(), "zh-TW", { numeric: true });
  if (codeCmp !== 0) return codeCmp;

  // 5. 原始規格備用排序
  return (a.size || "").trim().localeCompare((b.size || "").trim(), "zh-TW", { numeric: true });
}

/**
 * 依據發放明細計算二維交叉彙總表
 */
export function buildPivotTableData(
  lines: RawIssueLineInput[],
  stockMap?: Map<string, ItemStockInfo>,
): PivotTableData {
  // 建立動態分店清單：嚴格僅抓取並列出使用者指定的 22 個機構單位
  const institutionMap = new Map<string, { shortName: string; code: string }>();
  for (const name of ORDERED_INSTITUTION_NAMES) {
    const entry = Object.values(INSTITUTION_CODE_MAP).find((e) => e.shortName === name);
    institutionMap.set(name, { shortName: name, code: entry?.code ?? "" });
  }

  const institutions = Array.from(institutionMap.values());

  // 依 (itemCode, size) 聚合
  type GroupKey = string;
  const groups = new Map<GroupKey, PivotRow>();

  for (const line of lines) {
    const qty = Number(line.quantity) || 0;
    if (qty <= 0) continue;

    // 單位過濾：只要抓取指定的 22 個單位（福, 氣, 心, 平, 安, 春, 日, 照, 風, 景, 山, 泉, 水, 清, 涼, 護家, 含笑, 法人, 一館, 二館, 三館, 幼），其他的都不用抓取
    const { shortName } = resolveInstitutionInfo(line.institutionCodeOrName);
    if (!ALLOWED_INSTITUTION_NAMES.has(shortName)) {
      continue;
    }

    const itemCode = (line.itemCode || "").trim();
    const itemName = (line.itemName || "").trim();
    const size = (line.size || "").trim();
    const unit = (line.unit || "件").trim();

    const key = `${itemCode}__${size}`;
    let group = groups.get(key);
    if (!group) {
      const stock = stockMap?.get(itemCode);
      group = {
        itemCode,
        itemName,
        size,
        unit,
        onHand: stock?.onHand ?? 0,
        quantitiesByInstitution: {},
        totalIssued: 0,
        increaseQuantity: 0,
      };
      groups.set(key, group);
    } else if (!group.itemName && itemName) {
      group.itemName = itemName;
    }

    group.quantitiesByInstitution[shortName] = (group.quantitiesByInstitution[shortName] || 0) + qty;
    group.totalIssued += qty;
  }

  // 依品名連帶品號排序資料列，將相同類似的品名排列在一起
  const rows = Array.from(groups.values()).sort(comparePivotRows);

  // 分配 stockMap 的庫增量 (increaseQuantity)
  const assignedItemCodes = new Set<string>();

  if (stockMap) {
    // 1. 若該品號已有請領發放列，將該品號增庫量賦予給排序後的第一個規格列（避免多尺碼重複加總）
    for (const row of rows) {
      if (!assignedItemCodes.has(row.itemCode)) {
        const stock = stockMap.get(row.itemCode);
        if (stock) {
          row.increaseQuantity = Number(stock.increaseQuantity) || 0;
          if (stock.onHand != null) row.onHand = Number(stock.onHand) || 0;
          assignedItemCodes.add(row.itemCode);
        }
      }
    }

    // 2. 對於當期只有「額外補庫」、「隨單增庫」，或無任何分店請領發放的庫存品項，建立獨立列
    for (const [itemCode, stock] of stockMap.entries()) {
      if (!assignedItemCodes.has(itemCode)) {
        const inc = Number(stock.increaseQuantity) || 0;
        const onHand = Number(stock.onHand) || 0;
        rows.push({
          itemCode,
          itemName: stock.itemName || itemCode,
          size: stock.size || "",
          unit: stock.unit || "件",
          onHand,
          quantitiesByInstitution: {},
          totalIssued: 0,
          increaseQuantity: inc,
        });
        assignedItemCodes.add(itemCode);
      }
    }

    // 重新排序（包含補庫品項）
    rows.sort(comparePivotRows);
  }

  // 計算每個分店的垂直總計
  const totalByInstitution: Record<string, number> = {};
  let grandTotal = 0;

  for (const inst of institutions) {
    totalByInstitution[inst.shortName] = 0;
  }

  for (const row of rows) {
    for (const inst of institutions) {
      const q = row.quantitiesByInstitution[inst.shortName] || 0;
      totalByInstitution[inst.shortName] += q;
    }
    grandTotal += row.totalIssued;
  }

  return {
    institutions,
    rows,
    totalByInstitution,
    grandTotal,
  };
}

/**
 * 試算表欄位英文字母轉換（1 -> A, 27 -> AA, etc.）
 */
export function getExcelColumnName(colIndex: number): string {
  let temp: number;
  let letter = "";
  while (colIndex > 0) {
    temp = (colIndex - 1) % 26;
    letter = String.fromCharCode(temp + 65) + letter;
    colIndex = Math.floor((colIndex - temp - 1) / 26);
  }
  return letter;
}

/**
 * 轉義 XML 特殊字元
 */
function escapeXml(unsafe: string | number | null | undefined): string {
  if (unsafe == null) return "";
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export type ExportExcelOptions = {
  title?: string;
  dateRangeLabel?: string;
  notice?: string;
};

/**
 * 產生標準 XLSX 二進位資料 (Uint8Array)
 */
export function generatePivotXlsx(
  pivotData: PivotTableData,
  options: ExportExcelOptions = {},
): Uint8Array {
  const {
    title = "平日制服領用表",
    dateRangeLabel = "",
    notice = "提交檔案日：每月22日中午12:00 mail提供已簽核紙本及電子檔給事務組",
  } = options;

  const displayTitle = dateRangeLabel
    ? (title.includes(dateRangeLabel) ? title : `${title} ( ${dateRangeLabel} )`)
    : title;

  const { institutions, rows } = pivotData;
  const instCount = institutions.length;

  // 計算欄位索引 (1-indexed)
  // 固定左側欄：
  // 1: 項次 (A)
  // 2: 品號 (B)
  // 3: 品名 (C)
  // 4: 規格 (D)
  // 5: 期初量 (E)
  const leftColCount = 5;
  const firstInstCol = leftColCount + 1; // 6 (F)
  const lastInstCol = leftColCount + instCount; // e.g. 5 + 22 = 27 (AA)

  // 右側統計欄：
  // lastInstCol + 1: 請領合計 (B)
  // lastInstCol + 2: 月結量 (C=A-B)
  // lastInstCol + 3: 事務組偶數月抽盤量 (D)
  // lastInstCol + 4: 抽盤差異 (E)
  // lastInstCol + 5: 備註
  // lastInstCol + 6: 庫增量 (F)
  // lastInstCol + 7: 本次發放量 (G=D+F)
  // lastInstCol + 8: 冬夏領退量 (H)
  // lastInstCol + 9: 期末量(下期期初) (I)
  const totalCols = lastInstCol + 9;

  const sumColIndex = lastInstCol + 1;
  const balanceColIndex = lastInstCol + 2;
  const damageColIndex = lastInstCol + 3;
  const estimateColIndex = lastInstCol + 4;
  const remarkColIndex = lastInstCol + 5;
  const replenishmentColIndex = lastInstCol + 6;
  const issueColIndex = lastInstCol + 7;
  const returnColIndex = lastInstCol + 8;
  const finalColIndex = lastInstCol + 9;

  const sumColName = getExcelColumnName(sumColIndex);
  const balanceColName = getExcelColumnName(balanceColIndex);
  const damageColName = getExcelColumnName(damageColIndex);
  const estimateColName = getExcelColumnName(estimateColIndex);
  const remarkColName = getExcelColumnName(remarkColIndex);
  const replenishmentColName = getExcelColumnName(replenishmentColIndex);
  const issueColName = getExcelColumnName(issueColIndex);
  const returnColName = getExcelColumnName(returnColIndex);
  const finalColName = getExcelColumnName(finalColIndex);

  const firstInstColName = getExcelColumnName(firstInstCol);
  const lastInstColName = getExcelColumnName(lastInstCol);

  // XML 建立
  const xmlRows: string[] = [];

  // Row 1: 大標題列與區間提示
  // A1: 標題與發放區間 (例如：平日制服領用表 ( 2026-09-21 ～ 2026-10-20 )), H1: 繳交日期提示
  xmlRows.push(`  <row r="1" ht="34" customHeight="1">
    <c r="A1" t="inlineStr" s="1"><is><t>${escapeXml(displayTitle)}</t></is></c>
    <c r="H1" t="inlineStr" s="2"><is><t>${escapeXml(notice)}</t></is></c>
  </row>`);

  // 邊框與樣式動態註冊管理器（支援全表格最外圍粗外框線、換品項底端雙框線與各色表頭）
  type BorderDef = {
    top: "thin" | "medium";
    bottom: "thin" | "double" | "medium";
    left: "thin" | "medium";
    right: "thin" | "medium";
  };
  type CellStyleType =
    | "headerGray"    // 灰底表頭 (10pt bold, center, wrapText)
    | "headerGreen"   // 綠底表頭 #E2EFDA (10pt bold, center, wrapText)
    | "headerYellow"  // 黃底表頭 #FFF2CC (10pt bold, center, wrapText)
    | "headerPink"    // 粉紫底表頭 #FFCCFF (10pt bold, center, wrapText)
    | "headerWhite"   // 白底表頭 (10pt bold, center, wrapText)
    | "subHeaderGray" // 灰底簡稱 (10pt bold, center)
    | "codeGray"      // 灰底代碼 (9pt, center)
    | "symbolGray"    // 灰底符號 (10pt bold, center)
    | "symbolGreen"   // 綠底符號 #E2EFDA (10pt bold, center)
    | "symbolYellow"  // 黃底符號 #FFF2CC (10pt bold, center)
    | "symbolPink"    // 粉紫底符號 #FFCCFF (10pt bold, center)
    | "symbolWhite"   // 白底符號 (10pt bold, center)
    | "dataCenter"    // 資料列置中數值 (11pt, center)
    | "dataLeft"      // 資料列靠左文字 (11pt, left)
    | "dataGreen"     // 資料列綠底 (11pt, fill 4, center)
    | "totalCenter"   // 合計列灰底 (10pt bold, fill 2, center)
    | "totalGreen";   // 合計列綠底 (10pt bold, fill 4, center)

  const customBorders = new Map<string, number>();
  const customBorderXmls: string[] = [];
  const customXfs = new Map<string, number>();
  const customXfXmls: string[] = [];

  function getCellStyleId(type: CellStyleType, border: BorderDef): number {
    let borderId = 1;
    const isDefaultBorder = border.top === "thin" && border.bottom === "thin" && border.left === "thin" && border.right === "thin";
    if (!isDefaultBorder) {
      const bKey = `${border.top}_${border.bottom}_${border.left}_${border.right}`;
      if (customBorders.has(bKey)) {
        borderId = customBorders.get(bKey)!;
      } else {
        borderId = 3 + customBorderXmls.length;
        customBorders.set(bKey, borderId);
        const topColor = border.top === "medium" ? "FF000000" : "FFD4D4D4";
        const bottomColor = border.bottom === "thin" ? "FFD4D4D4" : "FF000000";
        const leftColor = border.left === "medium" ? "FF000000" : "FFD4D4D4";
        const rightColor = border.right === "medium" ? "FF000000" : "FFD4D4D4";
        customBorderXmls.push(`    <border>
      <left style="${border.left}"><color rgb="${leftColor}"/></left>
      <right style="${border.right}"><color rgb="${rightColor}"/></right>
      <top style="${border.top}"><color rgb="${topColor}"/></top>
      <bottom style="${border.bottom}"><color rgb="${bottomColor}"/></bottom>
      <diagonal/>
    </border>`);
      }
    }

    if (borderId === 1) {
      if (type === "headerGray") return 3;
      if (type === "subHeaderGray") return 4;
      if (type === "codeGray") return 5;
      if (type === "dataCenter") return 6;
      if (type === "dataLeft") return 7;
      if (type === "totalCenter") return 8;
      if (type === "headerGreen") return 14;
      if (type === "symbolGreen") return 15;
      if (type === "dataGreen") return 17;
      if (type === "totalGreen") return 18;
    }

    const xfKey = `${type}_${borderId}`;
    if (customXfs.has(xfKey)) {
      return customXfs.get(xfKey)!;
    }

    const xfId = 19 + customXfXmls.length;
    customXfs.set(xfKey, xfId);

    let fontId = 2; // 預設 13pt bold (原 12pt bold)
    if (type.startsWith("header")) {
      fontId = 0; // 13pt normal (A2:AM2 取消粗體)
    } else if (type === "codeGray") {
      fontId = 3; // 11pt
    } else if (type === "dataCenter" || type === "dataLeft" || type === "dataGreen") {
      fontId = 0; // 13pt normal
    }

    let fillId = 0;
    if (type === "headerGray" || type === "totalCenter" || type === "codeGray") {
      fillId = 2; // FFF2F2F2
    } else if (type === "subHeaderGray" || type === "symbolGray") {
      fillId = 3; // FFEAEAEA
    } else if (type === "headerGreen" || type === "symbolGreen" || type === "dataGreen" || type === "totalGreen") {
      fillId = 4; // FFE2EFDA
    } else if (type === "headerYellow" || type === "symbolYellow") {
      fillId = 5; // FFFFF2CC
    } else if (type === "headerPink" || type === "symbolPink") {
      fillId = 6; // FFFFCCFF
    } else if (type === "headerWhite") {
      fillId = 7; // FFFFFFFF
    }

    const align = type === "dataLeft" ? "left" : "center";
    const isHeaderWrap = type.startsWith("header");
    const wrapAttr = isHeaderWrap ? ' wrapText="1"' : "";
    const applyFont = fontId > 0 ? ' applyFont="1"' : "";
    const applyFill = fillId > 0 ? ' applyFill="1"' : "";

    customXfXmls.push(`    <xf numFmtId="0" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}"${applyFont}${applyFill} applyBorder="1" applyAlignment="1"><alignment horizontal="${align}" vertical="center"${wrapAttr}/></xf>`);
    return xfId;
  }

  // Row 2: 表頭層 1 (分店大標題 / 統計標題)
  // 最外圍頂部為 medium 粗黑線，最左欄 A 欄 left 為 medium
  const a2Style = getCellStyleId("headerGray", { top: "medium", bottom: "thin", left: "medium", right: "thin" });
  const b2Style = getCellStyleId("headerGray", { top: "medium", bottom: "thin", left: "thin", right: "thin" });
  const c2Style = getCellStyleId("headerGray", { top: "medium", bottom: "thin", left: "thin", right: "thin" });
  const d2Style = getCellStyleId("headerGray", { top: "medium", bottom: "thin", left: "thin", right: "thin" });
  const e2Style = getCellStyleId("headerGreen", { top: "medium", bottom: "thin", left: "thin", right: "thin" });
  const instGroupStyle = getCellStyleId("headerGray", { top: "medium", bottom: "thin", left: "thin", right: "thin" });

  const sumHdrStyle = getCellStyleId("headerYellow", { top: "medium", bottom: "thin", left: "thin", right: "thin" });
  const balanceHdrStyle = getCellStyleId("headerGreen", { top: "medium", bottom: "thin", left: "thin", right: "thin" });
  const damageHdrStyle = getCellStyleId("headerWhite", { top: "medium", bottom: "thin", left: "thin", right: "thin" });
  const estimateHdrStyle = getCellStyleId("headerWhite", { top: "medium", bottom: "thin", left: "thin", right: "thin" });
  const remarkHdrStyle = getCellStyleId("headerWhite", { top: "medium", bottom: "thin", left: "thin", right: "thin" });
  const replenishmentHdrStyle = getCellStyleId("headerYellow", { top: "medium", bottom: "thin", left: "thin", right: "thin" });
  const issueHdrStyle = getCellStyleId("headerYellow", { top: "medium", bottom: "thin", left: "thin", right: "thin" });
  const returnHdrStyle = getCellStyleId("headerPink", { top: "medium", bottom: "thin", left: "thin", right: "thin" });
  const finalHdrStyle = getCellStyleId("headerGreen", { top: "medium", bottom: "thin", left: "thin", right: "medium" });

  const instGroupCellsRow2 = institutions.map((_, idx) => {
    const colName = getExcelColumnName(firstInstCol + idx);
    if (idx === 0) {
      return `<c r="${colName}2" t="inlineStr" s="${instGroupStyle}"><is><t>請領數量表(當月各品號領退淨額數量)【依員工編列所屬機構與公司】</t></is></c>`;
    }
    return `<c r="${colName}2" s="${instGroupStyle}"/>`;
  }).join("\n    ");
  const rightGroupHeader = `
    <c r="${sumColName}2" t="inlineStr" s="${sumHdrStyle}"><is><t>請領&#10;合計</t></is></c>
    <c r="${balanceColName}2" t="inlineStr" s="${balanceHdrStyle}"><is><t>月結量&#10;(抽盤)</t></is></c>
    <c r="${damageColName}2" t="inlineStr" s="${damageHdrStyle}"><is><t>事務組&#10;偶數月&#10;抽盤</t></is></c>
    <c r="${estimateColName}2" t="inlineStr" s="${estimateHdrStyle}"><is><t>抽盤&#10;差異</t></is></c>
    <c r="${remarkColName}2" t="inlineStr" s="${remarkHdrStyle}"><is><t>備註&#10;差異說明</t></is></c>
    <c r="${replenishmentColName}2" t="inlineStr" s="${replenishmentHdrStyle}"><is><t>庫增量</t></is></c>
    <c r="${issueColName}2" t="inlineStr" s="${issueHdrStyle}"><is><t>本次&#10;發放量</t></is></c>
    <c r="${returnColName}2" t="inlineStr" s="${returnHdrStyle}"><is><t>冬夏&#10;領退量</t></is></c>
    <c r="${finalColName}2" t="inlineStr" s="${finalHdrStyle}"><is><t>期末量&#10;(下期期初)</t></is></c>
  `;

  xmlRows.push(`  <row r="2" ht="22" customHeight="1">
    <c r="A2" t="inlineStr" s="${a2Style}"><is><t>項次</t></is></c>
    <c r="B2" t="inlineStr" s="${b2Style}"><is><t>品號</t></is></c>
    <c r="C2" t="inlineStr" s="${c2Style}"><is><t>品名</t></is></c>
    <c r="D2" t="inlineStr" s="${d2Style}"><is><t>規&#10;格</t></is></c>
    <c r="E2" t="inlineStr" s="${e2Style}"><is><t>期&#10;初&#10;量</t></is></c>
    ${instGroupCellsRow2}
    ${rightGroupHeader}
  </row>`);

  // Row 3: 表頭層 2 (分店簡稱，左側與右側統計欄為被合併的佔位格)
  const a3Style = getCellStyleId("headerGray", { top: "thin", bottom: "thin", left: "medium", right: "thin" });
  const mid3Style = getCellStyleId("headerGray", { top: "thin", bottom: "thin", left: "thin", right: "thin" });
  const e3Style = getCellStyleId("headerGreen", { top: "thin", bottom: "thin", left: "thin", right: "thin" });

  const instNamesCells = institutions.map((inst, idx) => {
    const colName = getExcelColumnName(firstInstCol + idx);
    const s = getCellStyleId("subHeaderGray", { top: "thin", bottom: "thin", left: "thin", right: "thin" });
    return `<c r="${colName}3" t="inlineStr" s="${s}"><is><t>${escapeXml(inst.shortName)}</t></is></c>`;
  }).join("\n    ");

  const sum3Style = getCellStyleId("headerYellow", { top: "thin", bottom: "thin", left: "thin", right: "thin" });
  const balance3Style = getCellStyleId("headerGreen", { top: "thin", bottom: "thin", left: "thin", right: "thin" });
  const damage3Style = getCellStyleId("headerWhite", { top: "thin", bottom: "thin", left: "thin", right: "thin" });
  const estimate3Style = getCellStyleId("headerWhite", { top: "thin", bottom: "thin", left: "thin", right: "thin" });
  const remark3Style = getCellStyleId("headerWhite", { top: "thin", bottom: "thin", left: "thin", right: "thin" });
  const replenishment3Style = getCellStyleId("headerYellow", { top: "thin", bottom: "thin", left: "thin", right: "thin" });
  const issue3Style = getCellStyleId("headerYellow", { top: "thin", bottom: "thin", left: "thin", right: "thin" });
  const return3Style = getCellStyleId("headerPink", { top: "thin", bottom: "thin", left: "thin", right: "thin" });
  const final3Style = getCellStyleId("headerGreen", { top: "thin", bottom: "thin", left: "thin", right: "medium" });

  const rightPlaceholderCellsRow3 = `
    <c r="${sumColName}3" s="${sum3Style}"/>
    <c r="${balanceColName}3" s="${balance3Style}"/>
    <c r="${damageColName}3" s="${damage3Style}"/>
    <c r="${estimateColName}3" s="${estimate3Style}"/>
    <c r="${remarkColName}3" s="${remark3Style}"/>
    <c r="${replenishmentColName}3" s="${replenishment3Style}"/>
    <c r="${issueColName}3" s="${issue3Style}"/>
    <c r="${returnColName}3" s="${return3Style}"/>
    <c r="${finalColName}3" s="${final3Style}"/>
  `;

  xmlRows.push(`  <row r="3" ht="22" customHeight="1">
    <c r="A3" s="${a3Style}"/>
    <c r="B3" s="${mid3Style}"/>
    <c r="C3" s="${mid3Style}"/>
    <c r="D3" s="${mid3Style}"/>
    <c r="E3" s="${e3Style}"/>
    ${instNamesCells}
    ${rightPlaceholderCellsRow3}
  </row>`);

  // Row 4: 表頭層 3 (分店代碼，左側與右側統計欄為被合併的佔位格)
  const a4Style = getCellStyleId("headerGray", { top: "thin", bottom: "thin", left: "medium", right: "thin" });
  const mid4Style = getCellStyleId("headerGray", { top: "thin", bottom: "thin", left: "thin", right: "thin" });
  const e4Style = getCellStyleId("headerGreen", { top: "thin", bottom: "thin", left: "thin", right: "thin" });

  const instCodesCells = institutions.map((inst, idx) => {
    const colName = getExcelColumnName(firstInstCol + idx);
    const s = getCellStyleId("codeGray", { top: "thin", bottom: "thin", left: "thin", right: "thin" });
    return `<c r="${colName}4" t="inlineStr" s="${s}"><is><t>${escapeXml(inst.code)}</t></is></c>`;
  }).join("\n    ");

  const sum4Style = getCellStyleId("headerYellow", { top: "thin", bottom: "thin", left: "thin", right: "thin" });
  const balance4Style = getCellStyleId("headerGreen", { top: "thin", bottom: "thin", left: "thin", right: "thin" });
  const damage4Style = getCellStyleId("headerWhite", { top: "thin", bottom: "thin", left: "thin", right: "thin" });
  const estimate4Style = getCellStyleId("headerWhite", { top: "thin", bottom: "thin", left: "thin", right: "thin" });
  const remark4Style = getCellStyleId("headerWhite", { top: "thin", bottom: "thin", left: "thin", right: "thin" });
  const replenishment4Style = getCellStyleId("headerYellow", { top: "thin", bottom: "thin", left: "thin", right: "thin" });
  const issue4Style = getCellStyleId("headerYellow", { top: "thin", bottom: "thin", left: "thin", right: "thin" });
  const return4Style = getCellStyleId("headerPink", { top: "thin", bottom: "thin", left: "thin", right: "thin" });
  const final4Style = getCellStyleId("headerGreen", { top: "thin", bottom: "thin", left: "thin", right: "medium" });

  const rightPlaceholderCellsRow4 = `
    <c r="${sumColName}4" s="${sum4Style}"/>
    <c r="${balanceColName}4" s="${balance4Style}"/>
    <c r="${damageColName}4" s="${damage4Style}"/>
    <c r="${estimateColName}4" s="${estimate4Style}"/>
    <c r="${remarkColName}4" s="${remark4Style}"/>
    <c r="${replenishmentColName}4" s="${replenishment4Style}"/>
    <c r="${issueColName}4" s="${issue4Style}"/>
    <c r="${returnColName}4" s="${return4Style}"/>
    <c r="${finalColName}4" s="${final4Style}"/>
  `;

  xmlRows.push(`  <row r="4" ht="20" customHeight="1">
    <c r="A4" s="${a4Style}"/>
    <c r="B4" s="${mid4Style}"/>
    <c r="C4" s="${mid4Style}"/>
    <c r="D4" s="${mid4Style}"/>
    <c r="E4" s="${e4Style}"/>
    ${instCodesCells}
    ${rightPlaceholderCellsRow4}
  </row>`);

  // Row 5: 表頭層 4 (符號與計算式代號列，底部為 medium 粗黑分隔線)
  const a5Style = getCellStyleId("symbolGray", { top: "thin", bottom: "medium", left: "medium", right: "thin" });
  const mid5Style = getCellStyleId("symbolGray", { top: "thin", bottom: "medium", left: "thin", right: "thin" });
  const e5Style = getCellStyleId("symbolGreen", { top: "thin", bottom: "medium", left: "thin", right: "thin" });

  const instBlankCellsRow5 = institutions.map((_, idx) => {
    const colName = getExcelColumnName(firstInstCol + idx);
    const s = getCellStyleId("symbolGray", { top: "thin", bottom: "medium", left: "thin", right: "thin" });
    return `<c r="${colName}5" s="${s}"/>`;
  }).join("");

  const sum5Style = getCellStyleId("symbolYellow", { top: "thin", bottom: "medium", left: "thin", right: "thin" });
  const balance5Style = getCellStyleId("symbolGreen", { top: "thin", bottom: "medium", left: "thin", right: "thin" });
  const damage5Style = getCellStyleId("symbolWhite", { top: "thin", bottom: "medium", left: "thin", right: "thin" });
  const estimate5Style = getCellStyleId("symbolWhite", { top: "thin", bottom: "medium", left: "thin", right: "thin" });
  const remark5Style = getCellStyleId("symbolWhite", { top: "thin", bottom: "medium", left: "thin", right: "thin" });
  const replenishment5Style = getCellStyleId("symbolYellow", { top: "thin", bottom: "medium", left: "thin", right: "thin" });
  const issue5Style = getCellStyleId("symbolYellow", { top: "thin", bottom: "medium", left: "thin", right: "thin" });
  const return5Style = getCellStyleId("symbolPink", { top: "thin", bottom: "medium", left: "thin", right: "thin" });
  const final5Style = getCellStyleId("symbolGreen", { top: "thin", bottom: "medium", left: "thin", right: "medium" });

  const rightSymbolCellsRow5 = `
    <c r="${sumColName}5" t="inlineStr" s="${sum5Style}"><is><t>B</t></is></c>
    <c r="${balanceColName}5" t="inlineStr" s="${balance5Style}"><is><t>C=A-B</t></is></c>
    <c r="${damageColName}5" t="inlineStr" s="${damage5Style}"><is><t>D</t></is></c>
    <c r="${estimateColName}5" t="inlineStr" s="${estimate5Style}"><is><t>E=D-C</t></is></c>
    <c r="${remarkColName}5" s="${remark5Style}"/>
    <c r="${replenishmentColName}5" t="inlineStr" s="${replenishment5Style}"><is><t>F</t></is></c>
    <c r="${issueColName}5" t="inlineStr" s="${issue5Style}"><is><t>G=B+F</t></is></c>
    <c r="${returnColName}5" t="inlineStr" s="${return5Style}"><is><t>H</t></is></c>
    <c r="${finalColName}5" t="inlineStr" s="${final5Style}"><is><t>I=C+E+G+H</t></is></c>
  `;

  xmlRows.push(`  <row r="5" ht="20" customHeight="1">
    <c r="A5" s="${a5Style}"/>
    <c r="B5" s="${mid5Style}"/>
    <c r="C5" s="${mid5Style}"/>
    <c r="D5" s="${mid5Style}"/>
    <c r="E5" t="inlineStr" s="${e5Style}"><is><t>A</t></is></c>
    ${instBlankCellsRow5}
    ${rightSymbolCellsRow5}
  </row>`);

  // Row 6 開始為資料列
  const startDataRow = 6;
  rows.forEach((row, index) => {
    const r = startDataRow + index;
    const isFirstDataRow = (index === 0);
    const isCategoryEnd = index < rows.length - 1 &&
      getItemCategory(row.itemName, row.size) !== getItemCategory(rows[index + 1].itemName, rows[index + 1].size);

    const rowTop: "thin" | "medium" = isFirstDataRow ? "medium" : "thin";
    const rowBottom: "thin" | "double" = isCategoryEnd ? "double" : "thin";

    function cellBorder(colIdx: number): BorderDef {
      return {
        top: rowTop,
        bottom: rowBottom,
        left: colIdx === 1 ? "medium" : "thin",
        right: colIdx === totalCols ? "medium" : "thin",
      };
    }

    const aStyle = getCellStyleId("dataCenter", cellBorder(1));
    const bStyle = getCellStyleId("dataLeft", cellBorder(2));
    const cStyle = getCellStyleId("dataLeft", cellBorder(3));
    const dStyle = getCellStyleId("dataCenter", cellBorder(4));
    const eStyle = getCellStyleId("dataGreen", cellBorder(5));

    const instQtyCells = institutions.map((inst, idx) => {
      const colIdx = firstInstCol + idx;
      const colName = getExcelColumnName(colIdx);
      const style = getCellStyleId("dataCenter", cellBorder(colIdx));
      const qty = row.quantitiesByInstitution[inst.shortName];
      if (qty && qty > 0) {
        return `<c r="${colName}${r}" s="${style}"><v>${qty}</v></c>`;
      }
      return `<c r="${colName}${r}" s="${style}"/>`;
    }).join("");

    const sumStyle = getCellStyleId("dataCenter", cellBorder(sumColIndex));
    const balanceStyle = getCellStyleId("dataGreen", cellBorder(balanceColIndex));
    const damageStyle = getCellStyleId("dataCenter", cellBorder(damageColIndex));
    const estimateStyle = getCellStyleId("dataCenter", cellBorder(estimateColIndex));
    const remarkStyle = getCellStyleId("dataLeft", cellBorder(remarkColIndex));
    const replenishmentStyle = getCellStyleId("dataCenter", cellBorder(replenishmentColIndex));
    const issueStyle = getCellStyleId("dataCenter", cellBorder(issueColIndex));
    const returnStyle = getCellStyleId("dataCenter", cellBorder(returnColIndex));
    const finalStyle = getCellStyleId("dataGreen", cellBorder(finalColIndex));

    // 公式
    const sumFormula = `SUM(${firstInstColName}${r}:${lastInstColName}${r})`;
    const balanceFormula = `E${r}-${sumColName}${r}`;
    const issueFormula = `${sumColName}${r}+${replenishmentColName}${r}`;
    const finalFormula = `${balanceColName}${r}+${estimateColName}${r}+${issueColName}${r}+${returnColName}${r}`;

    const totalIssuedVal = row.totalIssued;
    const onHandVal = row.onHand;
    const increaseVal = row.increaseQuantity;
    const balanceVal = onHandVal - totalIssuedVal;
    const issueVal = totalIssuedVal + increaseVal;
    const finalVal = balanceVal + issueVal;

    xmlRows.push(`  <row r="${r}" ht="22" customHeight="1">
    <c r="A${r}" s="${aStyle}"><v>${index + 1}</v></c>
    <c r="B${r}" t="inlineStr" s="${bStyle}"><is><t>${escapeXml(row.itemCode)}</t></is></c>
    <c r="C${r}" t="inlineStr" s="${cStyle}"><is><t>${escapeXml(row.itemName)}</t></is></c>
    <c r="D${r}" t="inlineStr" s="${dStyle}"><is><t>${escapeXml(row.size)}</t></is></c>
    <c r="E${r}" s="${eStyle}"><v>${onHandVal}</v></c>
    ${instQtyCells}
    <c r="${sumColName}${r}" s="${sumStyle}"><f>${sumFormula}</f><v>${totalIssuedVal}</v></c>
    <c r="${balanceColName}${r}" s="${balanceStyle}"><f>${balanceFormula}</f><v>${balanceVal}</v></c>
    <c r="${damageColName}${r}" s="${damageStyle}"/>
    <c r="${estimateColName}${r}" s="${estimateStyle}"/>
    <c r="${remarkColName}${r}" s="${remarkStyle}"/>
    <c r="${replenishmentColName}${r}" s="${replenishmentStyle}">${increaseVal > 0 ? `<v>${increaseVal}</v>` : ""}</c>
    <c r="${issueColName}${r}" s="${issueStyle}"><f>${issueFormula}</f><v>${issueVal}</v></c>
    <c r="${returnColName}${r}" s="${returnStyle}"/>
    <c r="${finalColName}${r}" s="${finalStyle}"><f>${finalFormula}</f><v>${finalVal}</v></c>
  </row>`);
  });

  // 合計列 (Total Row)
  const totalRowIndex = startDataRow + rows.length;
  if (rows.length > 0) {
    function totalCellBorder(colIdx: number): BorderDef {
      return {
        top: "thin",
        bottom: "medium", // 表格最外圍粗邊框底邊
        left: colIdx === 1 ? "medium" : "thin",
        right: colIdx === totalCols ? "medium" : "thin",
      };
    }

    const totalOnHand = rows.reduce((sum, r) => sum + (Number(r.onHand) || 0), 0);
    const onHandSumFormula = `SUM(E${startDataRow}:E${totalRowIndex - 1})`;

    const instSumCells = institutions.map((inst, idx) => {
      const colIdx = firstInstCol + idx;
      const colName = getExcelColumnName(colIdx);
      const style = getCellStyleId("totalCenter", totalCellBorder(colIdx));
      const formula = `SUM(${colName}${startDataRow}:${colName}${totalRowIndex - 1})`;
      const val = pivotData.totalByInstitution[inst.shortName] || 0;
      return `<c r="${colName}${totalRowIndex}" s="${style}"><f>${formula}</f><v>${val}</v></c>`;
    }).join("");

    const grandFormula = `SUM(${sumColName}${startDataRow}:${sumColName}${totalRowIndex - 1})`;
    const balanceSumFormula = `SUM(${balanceColName}${startDataRow}:${balanceColName}${totalRowIndex - 1})`;
    const totalBalanceVal = totalOnHand - pivotData.grandTotal;
    const damageSumFormula = `SUM(${damageColName}${startDataRow}:${damageColName}${totalRowIndex - 1})`;
    const estimateSumFormula = `SUM(${estimateColName}${startDataRow}:${estimateColName}${totalRowIndex - 1})`;
    const totalIncrease = rows.reduce((sum, r) => sum + (Number(r.increaseQuantity) || 0), 0);
    const replenishmentSumFormula = `SUM(${replenishmentColName}${startDataRow}:${replenishmentColName}${totalRowIndex - 1})`;
    const issueSumFormula = `SUM(${issueColName}${startDataRow}:${issueColName}${totalRowIndex - 1})`;
    const returnSumFormula = `SUM(${returnColName}${startDataRow}:${returnColName}${totalRowIndex - 1})`;
    const finalSumFormula = `SUM(${finalColName}${startDataRow}:${finalColName}${totalRowIndex - 1})`;
    const totalFinalVal = rows.reduce((sum, r) => sum + (Number(r.onHand) || 0) + (Number(r.increaseQuantity) || 0), 0);

    const totAStyle = getCellStyleId("totalCenter", totalCellBorder(1));
    const totBStyle = getCellStyleId("totalCenter", totalCellBorder(2));
    const totCStyle = getCellStyleId("totalCenter", totalCellBorder(3));
    const totDStyle = getCellStyleId("totalCenter", totalCellBorder(4));
    const totEStyle = getCellStyleId("totalGreen", totalCellBorder(5));
    const totSumStyle = getCellStyleId("totalCenter", totalCellBorder(sumColIndex));
    const totBalanceStyle = getCellStyleId("totalGreen", totalCellBorder(balanceColIndex));
    const totDamageStyle = getCellStyleId("totalCenter", totalCellBorder(damageColIndex));
    const totEstimateStyle = getCellStyleId("totalCenter", totalCellBorder(estimateColIndex));
    const totRemarkStyle = getCellStyleId("totalCenter", totalCellBorder(remarkColIndex));
    const totReplenishmentStyle = getCellStyleId("totalCenter", totalCellBorder(replenishmentColIndex));
    const totIssueStyle = getCellStyleId("totalCenter", totalCellBorder(issueColIndex));
    const totReturnStyle = getCellStyleId("totalCenter", totalCellBorder(returnColIndex));
    const totFinalStyle = getCellStyleId("totalGreen", totalCellBorder(finalColIndex));

    xmlRows.push(`  <row r="${totalRowIndex}" ht="24" customHeight="1">
    <c r="A${totalRowIndex}" t="inlineStr" s="${totAStyle}"><is><t>合計</t></is></c>
    <c r="B${totalRowIndex}" s="${totBStyle}"/>
    <c r="C${totalRowIndex}" s="${totCStyle}"/>
    <c r="D${totalRowIndex}" s="${totDStyle}"/>
    <c r="E${totalRowIndex}" s="${totEStyle}"><f>${onHandSumFormula}</f><v>${totalOnHand}</v></c>
    ${instSumCells}
    <c r="${sumColName}${totalRowIndex}" s="${totSumStyle}"><f>${grandFormula}</f><v>${pivotData.grandTotal}</v></c>
    <c r="${balanceColName}${totalRowIndex}" s="${totBalanceStyle}"><f>${balanceSumFormula}</f><v>${totalBalanceVal}</v></c>
    <c r="${damageColName}${totalRowIndex}" s="${totDamageStyle}"><f>${damageSumFormula}</f></c>
    <c r="${estimateColName}${totalRowIndex}" s="${totEstimateStyle}"><f>${estimateSumFormula}</f></c>
    <c r="${remarkColName}${totalRowIndex}" s="${totRemarkStyle}"/>
    <c r="${replenishmentColName}${totalRowIndex}" s="${totReplenishmentStyle}"><f>${replenishmentSumFormula}</f><v>${totalIncrease}</v></c>
    <c r="${issueColName}${totalRowIndex}" s="${totIssueStyle}"><f>${issueSumFormula}</f><v>${pivotData.grandTotal + totalIncrease}</v></c>
    <c r="${returnColName}${totalRowIndex}" s="${totReturnStyle}"><f>${returnSumFormula}</f></c>
    <c r="${finalColName}${totalRowIndex}" s="${totFinalStyle}"><f>${finalSumFormula}</f><v>${totalFinalVal}</v></c>
  </row>`);
  }

  // 底部附註與簽核人區塊
  const noteRowIndex = totalRowIndex + 1;
  const blankRowIndex = totalRowIndex + 2;
  const sigRow1 = totalRowIndex + 3;
  const sigRow2 = totalRowIndex + 4;

  // 附註列
  xmlRows.push(`  <row r="${noteRowIndex}" ht="22" customHeight="1">
    <c r="A${noteRowIndex}" t="inlineStr" s="9"><is><t>註：正本提供事務組簽核後，繳交財務室稽核留存。</t></is></c>
  </row>`);

  // 空白列
  xmlRows.push(`  <row r="${blankRowIndex}" ht="12" customHeight="1"/>`);

  // Helper: 產生連續欄位儲存格（維持合併區域四邊黑框）
  function makeCellRange(r: number, startCol: number, endCol: number, styleId: number, contentText?: string): string {
    const list: string[] = [];
    for (let c = startCol; c <= endCol; c++) {
      const col = getExcelColumnName(c);
      if (c === startCol && contentText) {
        list.push(`<c r="${col}${r}" t="inlineStr" s="${styleId}"><is><t>${contentText}</t></is></c>`);
      } else {
        list.push(`<c r="${col}${r}" s="${styleId}"/>`);
      }
    }
    return list.join("");
  }

  // 右側簽收欄位範圍（對齊請領合計 B 到冬夏領退量 H）
  const rSignLeftStart = sumColIndex;
  const rSignLeftEnd = Math.min(sumColIndex + 3, totalCols - 1);
  const rSignRightStart = rSignLeftEnd + 1;
  const rSignRightEnd = Math.min(rSignLeftEnd + 4, totalCols);

  // 簽核列 1：人資室
  const sigRow1Cells = [
    `<c r="A${sigRow1}" t="inlineStr" s="10"><is><t>人&#10;資&#10;室</t></is></c>`,
    makeCellRange(sigRow1, 2, 7, 11, "主管核准："),
    makeCellRange(sigRow1, 8, 12, 11, "覆核："),
    makeCellRange(sigRow1, 13, 19, 11, "人資經辦：許雅婷"),
    makeCellRange(sigRow1, rSignLeftStart, rSignLeftEnd, 10, "人資簽收&#10;(制服領貨)"),
    makeCellRange(sigRow1, rSignRightStart, rSignRightEnd, 13),
  ].join("");
  xmlRows.push(`  <row r="${sigRow1}" ht="52" customHeight="1">${sigRow1Cells}</row>`);

  // 簽核列 2：事務組
  const sigRow2Cells = [
    `<c r="A${sigRow2}" t="inlineStr" s="10"><is><t>事&#10;務&#10;組</t></is></c>`,
    makeCellRange(sigRow2, 2, 7, 11, "主管核准："),
    makeCellRange(sigRow2, 8, 12, 11, "覆核："),
    makeCellRange(sigRow2, 13, 19, 11, "事務經辦："),
  ].join("");
  xmlRows.push(`  <row r="${sigRow2}" ht="52" customHeight="1">${sigRow2Cells}</row>`);

  // 欄寬定義：規格欄 (D 欄) 固定設為 3.2，統計各欄依內容設定自動合適大小
  const colsXml = `  <cols>
    <col min="1" max="1" width="7" customWidth="1"/>
    <col min="2" max="2" width="16" customWidth="1"/>
    <col min="3" max="3" width="22" customWidth="1"/>
    <col min="4" max="4" width="3.2" customWidth="1"/>
    <col min="5" max="5" width="9" customWidth="1"/>
    <col min="${firstInstCol}" max="${lastInstCol}" width="6" customWidth="1"/>
    <col min="${sumColIndex}" max="${sumColIndex}" width="7.5" bestFit="1" customWidth="1"/>
    <col min="${balanceColIndex}" max="${balanceColIndex}" width="9" bestFit="1" customWidth="1"/>
    <col min="${damageColIndex}" max="${damageColIndex}" width="9" bestFit="1" customWidth="1"/>
    <col min="${estimateColIndex}" max="${estimateColIndex}" width="7.5" bestFit="1" customWidth="1"/>
    <col min="${remarkColIndex}" max="${remarkColIndex}" width="11" bestFit="1" customWidth="1"/>
    <col min="${replenishmentColIndex}" max="${replenishmentColIndex}" width="8.5" bestFit="1" customWidth="1"/>
    <col min="${issueColIndex}" max="${issueColIndex}" width="8.5" bestFit="1" customWidth="1"/>
    <col min="${returnColIndex}" max="${returnColIndex}" width="8.5" bestFit="1" customWidth="1"/>
    <col min="${finalColIndex}" max="${finalColIndex}" width="11.5" bestFit="1" customWidth="1"/>
  </cols>`;

  // 合併儲存格
  const mergeCells: string[] = [
    `A1:G1`,
    `H1:${getExcelColumnName(totalCols)}1`,
    // 表頭項次、品號、品名、規格、期初量 垂直合併 2~4 列
    `A2:A4`,
    `B2:B4`,
    `C2:C4`,
    `D2:D4`,
    `E2:E4`,
    // 分店大表頭 水平合併
    `${firstInstColName}2:${lastInstColName}2`,
    // 右側統計欄 垂直合併 2~4 列
    `${sumColName}2:${sumColName}4`,
    `${balanceColName}2:${balanceColName}4`,
    `${damageColName}2:${damageColName}4`,
    `${estimateColName}2:${estimateColName}4`,
    `${remarkColName}2:${remarkColName}4`,
    `${replenishmentColName}2:${replenishmentColName}4`,
    `${issueColName}2:${issueColName}4`,
    `${returnColName}2:${returnColName}4`,
    `${finalColName}2:${finalColName}4`,
  ];
  if (rows.length > 0) {
    mergeCells.push(`A${totalRowIndex}:D${totalRowIndex}`);
  }
  // 簽核人合併
  mergeCells.push(`B${sigRow1}:G${sigRow1}`);
  mergeCells.push(`H${sigRow1}:L${sigRow1}`);
  mergeCells.push(`M${sigRow1}:S${sigRow1}`);
  mergeCells.push(`${getExcelColumnName(rSignLeftStart)}${sigRow1}:${getExcelColumnName(rSignLeftEnd)}${sigRow1}`);
  mergeCells.push(`${getExcelColumnName(rSignRightStart)}${sigRow1}:${getExcelColumnName(rSignRightEnd)}${sigRow1}`);

  mergeCells.push(`B${sigRow2}:G${sigRow2}`);
  mergeCells.push(`H${sigRow2}:L${sigRow2}`);
  mergeCells.push(`M${sigRow2}:S${sigRow2}`);

  const mergeCellsXml = `  <mergeCells count="${mergeCells.length}">
    ${mergeCells.map((m) => `<mergeCell ref="${m}"/>`).join("\n    ")}
  </mergeCells>`;

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews>
    <sheetView tabSelected="1" workbookViewId="0" zoomScale="64" zoomScaleNormal="64"/>
  </sheetViews>
${colsXml}
  <sheetData>
${xmlRows.join("\n")}
  </sheetData>
${mergeCellsXml}
</worksheet>`;

  const totalBordersCount = 3 + customBorderXmls.length;
  const totalXfsCount = 19 + customXfXmls.length;
  const extraBordersXml = customBorderXmls.length > 0 ? `\n${customBorderXmls.join("\n")}` : "";
  const extraXfsXml = customXfXmls.length > 0 ? `\n${customXfXmls.join("\n")}` : "";

  // 樣式表 styles.xml
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="5">
    <font><sz val="13"/><name val="微軟正黑體"/></font>
    <font><sz val="20"/><b/><name val="微軟正黑體"/></font>
    <font><sz val="13"/><b/><name val="微軟正黑體"/></font>
    <font><sz val="11"/><name val="微軟正黑體"/></font>
    <font><sz val="13"/><b/><name val="微軟正黑體"/></font>
  </fonts>
  <fills count="8">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFEAEAEA"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFE2EFDA"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFCCFF"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFFFFF"/></patternFill></fill>
  </fills>
  <borders count="${totalBordersCount}">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border>
      <left style="thin"><color rgb="FFD4D4D4"/></left>
      <right style="thin"><color rgb="FFD4D4D4"/></right>
      <top style="thin"><color rgb="FFD4D4D4"/></top>
      <bottom style="thin"><color rgb="FFD4D4D4"/></bottom>
    </border>
    <border>
      <left style="thin"><color rgb="FF000000"/></left>
      <right style="thin"><color rgb="FF000000"/></right>
      <top style="thin"><color rgb="FF000000"/></top>
      <bottom style="thin"><color rgb="FF000000"/></bottom>
    </border>${extraBordersXml}
  </borders>
  <cellXfs count="${totalXfsCount}">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="2" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="2" fillId="3" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="3" fillId="2" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="2" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="3" fillId="0" borderId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="4" fillId="0" borderId="2" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="4" fillId="0" borderId="2" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="4" fillId="0" borderId="2" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="2" applyBorder="1"/>
    <!-- 綠底樣式 (FFE2EFDA) -->
    <xf numFmtId="0" fontId="0" fillId="4" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="2" fillId="4" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="3" fillId="4" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="4" borderId="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="4" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>${extraXfsXml}
  </cellXfs>
</styleSheet>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="平日制服領用表" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;

  const zipData = zipSync({
    "[Content_Types].xml": strToU8(contentTypesXml),
    "_rels/.rels": strToU8(relsXml),
    "xl/workbook.xml": strToU8(workbookXml),
    "xl/styles.xml": strToU8(stylesXml),
    "xl/_rels/workbook.xml.rels": strToU8(workbookRelsXml),
    "xl/worksheets/sheet1.xml": strToU8(sheetXml),
  });

  return zipData;
}

/**
 * 觸發瀏覽器下載 XLSX 檔案
 */
export function downloadPivotXlsx(data: Uint8Array, filename: string): void {
  const blob = new Blob([data as unknown as BlobPart], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename.endsWith(".xlsx") ? filename : `${filename}.xlsx`;
  anchor.click();
  URL.revokeObjectURL(url);
}
