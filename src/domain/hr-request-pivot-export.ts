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
  "47091980": { shortName: "含笑", code: "47091980" },
  "L1": { shortName: "法人", code: "L1" },
  "L67": { shortName: "一館", code: "L67" },
  "L5": { shortName: "二館", code: "L5" },
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
 * 依據發放明細計算二維交叉彙總表
 */
export function buildPivotTableData(
  lines: RawIssueLineInput[],
  stockMap?: Map<string, ItemStockInfo>,
): PivotTableData {
  // 建立動態分店清單：基礎 22 個分店固定排前，非 22 分店者排在後面
  const institutionMap = new Map<string, { shortName: string; code: string }>();
  for (const name of ORDERED_INSTITUTION_NAMES) {
    const entry = Object.values(INSTITUTION_CODE_MAP).find((e) => e.shortName === name);
    institutionMap.set(name, { shortName: name, code: entry?.code ?? "" });
  }

  // 收集非 22 規範中的其他分店
  for (const line of lines) {
    const info = resolveInstitutionInfo(line.institutionCodeOrName);
    if (!institutionMap.has(info.shortName)) {
      institutionMap.set(info.shortName, info);
    }
  }

  const institutions = Array.from(institutionMap.values());

  // 依 (itemCode, size) 聚合
  type GroupKey = string;
  const groups = new Map<GroupKey, PivotRow>();

  for (const line of lines) {
    const itemCode = (line.itemCode || "").trim();
    const itemName = (line.itemName || "").trim();
    const size = (line.size || "").trim();
    const unit = (line.unit || "件").trim();
    const qty = Number(line.quantity) || 0;
    if (qty <= 0) continue;

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

    const { shortName } = resolveInstitutionInfo(line.institutionCodeOrName);
    group.quantitiesByInstitution[shortName] = (group.quantitiesByInstitution[shortName] || 0) + qty;
    group.totalIssued += qty;
  }

  // 穩定排序資料列：先依品號排序，再依規格排序
  const rows = Array.from(groups.values()).sort((a, b) => {
    const codeCmp = a.itemCode.localeCompare(b.itemCode, "zh-TW");
    if (codeCmp !== 0) return codeCmp;
    return a.size.localeCompare(b.size, "zh-TW");
  });

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
    rows.sort((a, b) => {
      const codeCmp = a.itemCode.localeCompare(b.itemCode, "zh-TW");
      if (codeCmp !== 0) return codeCmp;
      return a.size.localeCompare(b.size, "zh-TW");
    });
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
  xmlRows.push(`  <row r="1" ht="26" customHeight="1">
    <c r="A1" t="inlineStr" s="1"><is><t>${escapeXml(displayTitle)}</t></is></c>
    <c r="H1" t="inlineStr" s="2"><is><t>${escapeXml(notice)}</t></is></c>
  </row>`);

  // Row 2: 表頭層 1 (分店大標題 / 統計標題)
  // A2~E2 為空白或合併，F2~lastInstCol 為「請領總數量 (當月各店請領並扣庫存數量)」
  const instGroupHeader = `<c r="${firstInstColName}2" t="inlineStr" s="3"><is><t>請領數量表(當月各品號領退淨額數量)【依員工編列所屬機構與公司】</t></is></c>`;
  const rightGroupHeader = `
    <c r="${sumColName}2" t="inlineStr" s="3"><is><t>請領合計</t></is></c>
    <c r="${balanceColName}2" t="inlineStr" s="14"><is><t>月結量(抽盤)</t></is></c>
    <c r="${damageColName}2" t="inlineStr" s="3"><is><t>事務組偶數月抽盤</t></is></c>
    <c r="${estimateColName}2" t="inlineStr" s="3"><is><t>抽盤差異</t></is></c>
    <c r="${remarkColName}2" t="inlineStr" s="3"><is><t>備註差異說明</t></is></c>
    <c r="${replenishmentColName}2" t="inlineStr" s="3"><is><t>庫增量</t></is></c>
    <c r="${issueColName}2" t="inlineStr" s="3"><is><t>本次發放量</t></is></c>
    <c r="${returnColName}2" t="inlineStr" s="3"><is><t>冬夏領退量</t></is></c>
    <c r="${finalColName}2" t="inlineStr" s="14"><is><t>期末量(下期期初)</t></is></c>
  `;

  xmlRows.push(`  <row r="2" ht="22" customHeight="1">
    <c r="A2" t="inlineStr" s="3"><is><t>項次</t></is></c>
    <c r="B2" t="inlineStr" s="3"><is><t>品號</t></is></c>
    <c r="C2" t="inlineStr" s="3"><is><t>品名</t></is></c>
    <c r="D2" t="inlineStr" s="3"><is><t>規格</t></is></c>
    <c r="E2" t="inlineStr" s="14"><is><t>期&#10;初&#10;量</t></is></c>
    ${instGroupHeader}
    ${rightGroupHeader}
  </row>`);

  // Row 3: 表頭層 2 (分店簡稱)
  const instNamesCells = institutions.map((inst, idx) => {
    const colName = getExcelColumnName(firstInstCol + idx);
    return `<c r="${colName}3" t="inlineStr" s="4"><is><t>${escapeXml(inst.shortName)}</t></is></c>`;
  }).join("\n    ");

  const rightSymbolCells = `
    <c r="${sumColName}3" t="inlineStr" s="4"><is><t>B</t></is></c>
    <c r="${balanceColName}3" t="inlineStr" s="15"><is><t>C=A-B</t></is></c>
    <c r="${damageColName}3" t="inlineStr" s="4"><is><t>D</t></is></c>
    <c r="${estimateColName}3" t="inlineStr" s="4"><is><t>E=D-C</t></is></c>
    <c r="${remarkColName}3" t="inlineStr" s="4"><is><t></t></is></c>
    <c r="${replenishmentColName}3" t="inlineStr" s="4"><is><t>F</t></is></c>
    <c r="${issueColName}3" t="inlineStr" s="4"><is><t>G=B+F</t></is></c>
    <c r="${returnColName}3" t="inlineStr" s="4"><is><t>H</t></is></c>
    <c r="${finalColName}3" t="inlineStr" s="15"><is><t>I=C+E+G+H</t></is></c>
  `;

  xmlRows.push(`  <row r="3" ht="20" customHeight="1">
    <c r="A3" s="4"/>
    <c r="B3" s="4"/>
    <c r="C3" s="4"/>
    <c r="D3" s="4"/>
    <c r="E3" t="inlineStr" s="15"><is><t>A</t></is></c>
    ${instNamesCells}
    ${rightSymbolCells}
  </row>`);

  // Row 4: 表頭層 3 (分店代碼)
  const instCodesCells = institutions.map((inst, idx) => {
    const colName = getExcelColumnName(firstInstCol + idx);
    return `<c r="${colName}4" t="inlineStr" s="5"><is><t>${escapeXml(inst.code)}</t></is></c>`;
  }).join("\n    ");

  xmlRows.push(`  <row r="4" ht="18" customHeight="1">
    <c r="A4" s="5"/>
    <c r="B4" s="5"/>
    <c r="C4" s="5"/>
    <c r="D4" s="5"/>
    <c r="E4" s="16"/>
    ${instCodesCells}
    <c r="${sumColName}4" s="5"/>
    <c r="${balanceColName}4" s="16"/>
    <c r="${damageColName}4" s="5"/>
    <c r="${estimateColName}4" s="5"/>
    <c r="${remarkColName}4" s="5"/>
    <c r="${replenishmentColName}4" s="5"/>
    <c r="${issueColName}4" s="5"/>
    <c r="${returnColName}4" s="5"/>
    <c r="${finalColName}4" s="16"/>
  </row>`);

  // Row 5 開始為資料列
  const startDataRow = 5;
  rows.forEach((row, index) => {
    const r = startDataRow + index;
    const instQtyCells = institutions.map((inst, idx) => {
      const colName = getExcelColumnName(firstInstCol + idx);
      const qty = row.quantitiesByInstitution[inst.shortName];
      if (qty && qty > 0) {
        return `<c r="${colName}${r}" s="6"><v>${qty}</v></c>`;
      }
      return `<c r="${colName}${r}" s="6"/>`;
    }).join("");

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

    xmlRows.push(`  <row r="${r}" ht="20" customHeight="1">
    <c r="A${r}" s="6"><v>${index + 1}</v></c>
    <c r="B${r}" t="inlineStr" s="7"><is><t>${escapeXml(row.itemCode)}</t></is></c>
    <c r="C${r}" t="inlineStr" s="7"><is><t>${escapeXml(row.itemName)}</t></is></c>
    <c r="D${r}" t="inlineStr" s="6"><is><t>${escapeXml(row.size)}</t></is></c>
    <c r="E${r}" s="17"><v>${onHandVal}</v></c>
    ${instQtyCells}
    <c r="${sumColName}${r}" s="6"><f>${sumFormula}</f><v>${totalIssuedVal}</v></c>
    <c r="${balanceColName}${r}" s="17"><f>${balanceFormula}</f><v>${balanceVal}</v></c>
    <c r="${damageColName}${r}" s="6"/>
    <c r="${estimateColName}${r}" s="6"/>
    <c r="${remarkColName}${r}" s="7"/>
    <c r="${replenishmentColName}${r}" s="6">${increaseVal > 0 ? `<v>${increaseVal}</v>` : ""}</c>
    <c r="${issueColName}${r}" s="6"><f>${issueFormula}</f><v>${issueVal}</v></c>
    <c r="${returnColName}${r}" s="6"/>
    <c r="${finalColName}${r}" s="17"><f>${finalFormula}</f><v>${finalVal}</v></c>
  </row>`);
  });

  // 合計列 (Total Row)
  const totalRowIndex = startDataRow + rows.length;
  if (rows.length > 0) {
    const totalOnHand = rows.reduce((sum, r) => sum + (Number(r.onHand) || 0), 0);
    const onHandSumFormula = `SUM(E${startDataRow}:E${totalRowIndex - 1})`;

    const instSumCells = institutions.map((inst, idx) => {
      const colName = getExcelColumnName(firstInstCol + idx);
      const formula = `SUM(${colName}${startDataRow}:${colName}${totalRowIndex - 1})`;
      const val = pivotData.totalByInstitution[inst.shortName] || 0;
      return `<c r="${colName}${totalRowIndex}" s="8"><f>${formula}</f><v>${val}</v></c>`;
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

    xmlRows.push(`  <row r="${totalRowIndex}" ht="22" customHeight="1">
    <c r="A${totalRowIndex}" t="inlineStr" s="8"><is><t>合計</t></is></c>
    <c r="B${totalRowIndex}" s="8"/>
    <c r="C${totalRowIndex}" s="8"/>
    <c r="D${totalRowIndex}" s="8"/>
    <c r="E${totalRowIndex}" s="18"><f>${onHandSumFormula}</f><v>${totalOnHand}</v></c>
    ${instSumCells}
    <c r="${sumColName}${totalRowIndex}" s="8"><f>${grandFormula}</f><v>${pivotData.grandTotal}</v></c>
    <c r="${balanceColName}${totalRowIndex}" s="18"><f>${balanceSumFormula}</f><v>${totalBalanceVal}</v></c>
    <c r="${damageColName}${totalRowIndex}" s="8"><f>${damageSumFormula}</f></c>
    <c r="${estimateColName}${totalRowIndex}" s="8"><f>${estimateSumFormula}</f></c>
    <c r="${remarkColName}${totalRowIndex}" s="8"/>
    <c r="${replenishmentColName}${totalRowIndex}" s="8"><f>${replenishmentSumFormula}</f><v>${totalIncrease}</v></c>
    <c r="${issueColName}${totalRowIndex}" s="8"><f>${issueSumFormula}</f><v>${pivotData.grandTotal + totalIncrease}</v></c>
    <c r="${returnColName}${totalRowIndex}" s="8"><f>${returnSumFormula}</f></c>
    <c r="${finalColName}${totalRowIndex}" s="18"><f>${finalSumFormula}</f><v>${totalFinalVal}</v></c>
  </row>`);
  }

  // 底部附註與簽核人區塊
  const noteRowIndex = totalRowIndex + 1;
  const blankRowIndex = totalRowIndex + 2;
  const sigRow1 = totalRowIndex + 3;
  const sigRow2 = totalRowIndex + 4;

  // 附註列
  xmlRows.push(`  <row r="${noteRowIndex}" ht="20" customHeight="1">
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
  xmlRows.push(`  <row r="${sigRow1}" ht="48" customHeight="1">${sigRow1Cells}</row>`);

  // 簽核列 2：事務組
  const sigRow2Cells = [
    `<c r="A${sigRow2}" t="inlineStr" s="10"><is><t>事&#10;務&#10;組</t></is></c>`,
    makeCellRange(sigRow2, 2, 7, 11, "主管核准："),
    makeCellRange(sigRow2, 8, 12, 11, "覆核："),
    makeCellRange(sigRow2, 13, 19, 11, "事務經辦："),
  ].join("");
  xmlRows.push(`  <row r="${sigRow2}" ht="48" customHeight="1">${sigRow2Cells}</row>`);

  // 欄寬定義
  const colsXml = `  <cols>
    <col min="1" max="1" width="6" customWidth="1"/>
    <col min="2" max="2" width="14" customWidth="1"/>
    <col min="3" max="3" width="18" customWidth="1"/>
    <col min="4" max="4" width="8" customWidth="1"/>
    <col min="5" max="5" width="8" customWidth="1"/>
    <col min="${firstInstCol}" max="${lastInstCol}" width="5" customWidth="1"/>
    <col min="${sumColIndex}" max="${sumColIndex}" width="10" customWidth="1"/>
    <col min="${balanceColIndex}" max="${balanceColIndex}" width="10" customWidth="1"/>
    <col min="${damageColIndex}" max="${totalCols}" width="11" customWidth="1"/>
  </cols>`;

  // 合併儲存格
  const mergeCells: string[] = [
    `A1:G1`,
    `H1:${getExcelColumnName(totalCols)}1`,
    `${firstInstColName}2:${lastInstColName}2`,
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
${colsXml}
  <sheetData>
${xmlRows.join("\n")}
  </sheetData>
${mergeCellsXml}
</worksheet>`;

  // 樣式表 styles.xml
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="5">
    <font><sz val="11"/><name val="微軟正黑體"/></font>
    <font><sz val="14"/><b/><name val="微軟正黑體"/></font>
    <font><sz val="10"/><b/><name val="微軟正黑體"/></font>
    <font><sz val="9"/><name val="微軟正黑體"/></font>
    <font><sz val="11"/><b/><name val="微軟正黑體"/></font>
  </fonts>
  <fills count="5">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFEAEAEA"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFE2EFDA"/></patternFill></fill>
  </fills>
  <borders count="3">
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
    </border>
  </borders>
  <cellXfs count="19">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="2" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
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
    <xf numFmtId="0" fontId="2" fillId="4" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="2" fillId="4" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="3" fillId="4" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="4" borderId="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="4" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
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
