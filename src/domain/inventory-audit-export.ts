import { zipSync, strToU8 } from "fflate";
import { compareUniformItems, type SortableUniformItem } from "./uniform-size";

export type InventoryAuditRow = SortableUniformItem & {
  itemId: string;
  itemCode: string;
  itemName: string;
  size: string;
  unit: string;
  // 人資倉
  hrOpening: number;      // 人資庫存((上月)月末存)
  issueQty: number;       // (本月)月發放量
  increaseQty: number;    // (本月)月增庫量
  replenishQty: number;   // (本月)月補貨量
  hrOnHand: number;       // 人資庫存((本月)月末存)
  // 總倉
  genOpening: number;     // 總倉庫存((上月)月末存)
  genIssueQty: number;    // (本月)月發貨量 (= increaseQty + replenishQty)
  genOnHand: number;      // 總倉庫存((本月)月末存)
  // 合併與 ERP
  combinedOnHand: number; // 合併庫存 (= hrOnHand + genOnHand)
  erpOnHand: number;      // ERP庫存
};

export type InventoryAuditExportOptions = {
  year: number;          // 例如 2026
  month: number;         // 例如 10
  prevMonth: number;     // 例如 9
  startDate: string;     // 例如 2026-09-21
  endDate: string;       // 例如 2026-10-20
};

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * 產生制服庫存簽核表（Excel / XLSX 格式）
 * 第一列：(今年)年(本月)月-制服庫存簽核表
 * 第二列：品號、品名、規格、人資庫存((上月)月末存)、(本月)月發放量、(本月)月增庫量、(本月)月補貨量、人資庫存((本月)月末存)、總倉庫存((上月)月末存)、(本月)月發貨量、總倉庫存((本月)月末存)、合併庫存、ERP庫存
 */
export function generateInventoryAuditXlsx(
  rows: InventoryAuditRow[],
  options: InventoryAuditExportOptions,
): Uint8Array {
  const sortedRows = [...rows].sort(compareUniformItems);
  const rocYear = options.year > 1911 ? options.year - 1911 : options.year;
  const title = `${rocYear}年${options.month} 月-制服庫存簽核表`;

  // 表頭定義：
  // A: 品   號
  // B: 品   名
  // C: 規格
  // D: 人資庫存&#10;(${options.prevMonth}月末存)
  // E: ${options.month}月發放量&#10;(人資表)&#10;(鼎新值)&#10;(貼上值)
  // F: ${options.month}月增庫量&#10;(含增額)&#10;(人資表)&#10;(貼上值)
  // G: ${options.month}月補貨量&#10;(含增額)&#10;(人資表)&#10;(貼上值)
  // H: 人資庫存&#10;(${options.month}月末存)
  // I: 總倉庫存&#10;(${options.prevMonth}月末存)&#10;(盤點值)
  // J: ${options.month}月發貨量&#10;(含增額)&#10;(人資表)&#10;(貼上值)
  // K: 總倉庫存&#10;(${options.month}月末存)&#10;(盤點值)
  // L: 合併庫存
  // M: ERP庫存
  const headerDefs = [
    { text: "品   號", style: 8 },
    { text: "品   名", style: 9 },
    { text: "規格", style: 9 },
    { text: `總倉庫存&#10;(${options.prevMonth}月末存)&#10;(盤點值)`, style: 10 },
    { text: `${options.month}月發放量&#10;(人資表)&#10;(鼎新值)&#10;(貼上值)`, style: 11 },
    { text: `${options.month}月增庫量&#10;(含增額)&#10;(人資表)&#10;(貼上值)`, style: 11 },
    { text: `${options.month}月補貨量&#10;(含增額)&#10;(人資表)&#10;(貼上值)`, style: 11 },
    { text: `人資庫存&#10;(${options.month}月末存)`, style: 10 },
    { text: `總倉庫存&#10;(${options.prevMonth}月末存)&#10;(盤點值)`, style: 10 },
    { text: `${options.month}月發貨量&#10;(含增額)&#10;(人資表)&#10;(貼上值)`, style: 11 },
    { text: `總倉庫存&#10;(${options.month}月末存)&#10;(盤點值)`, style: 10 },
    { text: "合併庫存", style: 10 },
    { text: "ERP庫存", style: 12 },
  ];

  const colLetters = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M"];

  // 1. 建立工作表 XML
  const sheetRows: string[] = [];

  // Row 1: 標題列（合併 A1:M1）
  sheetRows.push(
    `    <row r="1" ht="36" customHeight="1">` +
    `<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">${escapeXml(title)}</t></is></c>` +
    colLetters.slice(1).map((col) => `<c r="${col}1" s="1"/>`).join("") +
    `</row>`
  );

  // Row 2: 表頭列
  sheetRows.push(
    `    <row r="2" ht="70" customHeight="1">` +
    headerDefs.map((h, i) => `<c r="${colLetters[i]}2" s="${h.style}" t="inlineStr"><is><t xml:space="preserve">${h.text}</t></is></c>`).join("") +
    `</row>`
  );

  // Row 3 ~ Row N: 資料列
  let currentRow = 3;
  for (const r of sortedRows) {
    const rowIdx = currentRow;
    const cells: string[] = [
      // A: 品號 (左邊界，粗左框線)
      `<c r="A${rowIdx}" s="6" t="inlineStr"><is><t xml:space="preserve">${escapeXml(r.itemCode)}</t></is></c>`,
      // B: 品名 (內部靠左)
      `<c r="B${rowIdx}" s="3" t="inlineStr"><is><t xml:space="preserve">${escapeXml(r.itemName)}</t></is></c>`,
      // C: 規格 (內部置中)
      `<c r="C${rowIdx}" s="2" t="inlineStr"><is><t xml:space="preserve">${escapeXml(r.size || "—")}</t></is></c>`,
      // D: 總倉庫存((上月)月末存)(盤點值)
      `<c r="D${rowIdx}" s="4"><v>${r.hrOpening}</v></c>`,
      // E: (本月)月發放量
      `<c r="E${rowIdx}" s="4"><v>${r.issueQty}</v></c>`,
      // F: (本月)月增庫量
      `<c r="F${rowIdx}" s="4"><v>${r.increaseQty}</v></c>`,
      // G: (本月)月補貨量
      `<c r="G${rowIdx}" s="4"><v>${r.replenishQty}</v></c>`,
      // H: 人資庫存((本月)月末存) = D - E + F + G
      `<c r="H${rowIdx}" s="4"><f>D${rowIdx}-E${rowIdx}+F${rowIdx}+G${rowIdx}</f><v>${r.hrOnHand}</v></c>`,
      // I: 總倉庫存((上月)月末存)
      `<c r="I${rowIdx}" s="4"><v>${r.genOpening}</v></c>`,
      // J: (本月)月發貨量 = F + G
      `<c r="J${rowIdx}" s="4"><f>F${rowIdx}+G${rowIdx}</f><v>${r.genIssueQty}</v></c>`,
      // K: 總倉庫存((本月)月末存) = I - J
      `<c r="K${rowIdx}" s="4"><f>I${rowIdx}-J${rowIdx}</f><v>${r.genOnHand}</v></c>`,
      // L: 合併庫存 = H + K (內部粗體)
      `<c r="L${rowIdx}" s="5"><f>H${rowIdx}+K${rowIdx}</f><v>${r.combinedOnHand}</v></c>`,
      // M: ERP庫存 = L (右邊界，粗右框線)
      `<c r="M${rowIdx}" s="7"><f>L${rowIdx}</f><v>${r.erpOnHand}</v></c>`,
    ];
    sheetRows.push(`    <row r="${rowIdx}" ht="22" customHeight="1">${cells.join("")}</row>`);
    currentRow++;
  }

  // 總計列（Row currentRow）
  const totalRow = currentRow;
  const lastDataRow = totalRow - 1;
  const totalCells: string[] = [
    `<c r="A${totalRow}" s="13" t="inlineStr"><is><t xml:space="preserve">總計</t></is></c>`,
    `<c r="B${totalRow}" s="14"/>`,
    `<c r="C${totalRow}" s="14"/>`,
  ];

  for (let c = 3; c < colLetters.length - 1; c++) {
    const col = colLetters[c];
    if (sortedRows.length > 0) {
      totalCells.push(`<c r="${col}${totalRow}" s="15"><f>SUM(${col}3:${col}${lastDataRow})</f></c>`);
    } else {
      totalCells.push(`<c r="${col}${totalRow}" s="15"><v>0</v></c>`);
    }
  }
  // M 欄總計儲存格 (右側邊框)
  if (sortedRows.length > 0) {
    totalCells.push(`<c r="M${totalRow}" s="16"><f>SUM(M3:M${lastDataRow})</f></c>`);
  } else {
    totalCells.push(`<c r="M${totalRow}" s="16"><v>0</v></c>`);
  }
  sheetRows.push(`    <row r="${totalRow}" ht="24" customHeight="1">${totalCells.join("")}</row>`);

  // 總計下方空白間隔列
  const blankRow = totalRow + 1;
  const blankCells: string[] = [
    `<c r="A${blankRow}" s="17"/>`,
  ];
  for (let c = 1; c < colLetters.length - 1; c++) {
    const col = colLetters[c];
    blankCells.push(`<c r="${col}${blankRow}" s="18"/>`);
  }
  blankCells.push(`<c r="M${blankRow}" s="19"/>`);
  sheetRows.push(`    <row r="${blankRow}" ht="18" customHeight="1">${blankCells.join("")}</row>`);

  // 事務組簽核 3 列區塊
  const sig1 = totalRow + 2;
  const sig2 = totalRow + 3;
  const sig3 = totalRow + 4;

  function makeRangeCells(r: number, startIdx: number, endIdx: number, sId: number, text?: string): string {
    const res: string[] = [];
    for (let i = startIdx; i <= endIdx; i++) {
      const col = colLetters[i];
      if (i === startIdx && text) {
        res.push(`<c r="${col}${r}" s="${sId}" t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`);
      } else {
        res.push(`<c r="${col}${r}" s="${sId}"/>`);
      }
    }
    return res.join("");
  }

  // 簽核列 1: 主管簽章：
  const sig1Cells = [
    `<c r="A${sig1}" s="20" t="inlineStr"><is><t xml:space="preserve">事務組簽核</t></is></c>`,
    makeRangeCells(sig1, 1, 2, 21, "主管簽章："),
    makeRangeCells(sig1, 3, 11, 21),
    `<c r="M${sig1}" s="22"/>`,
  ].join("");
  sheetRows.push(`    <row r="${sig1}" ht="48" customHeight="1">${sig1Cells}</row>`);

  // 簽核列 2: 覆核簽章：
  const sig2Cells = [
    `<c r="A${sig2}" s="23"/>`,
    makeRangeCells(sig2, 1, 2, 24, "覆核簽章："),
    makeRangeCells(sig2, 3, 11, 24),
    `<c r="M${sig2}" s="25"/>`,
  ].join("");
  sheetRows.push(`    <row r="${sig2}" ht="48" customHeight="1">${sig2Cells}</row>`);

  // 簽核列 3: 經辦簽章：
  const sig3Cells = [
    `<c r="A${sig3}" s="26"/>`,
    makeRangeCells(sig3, 1, 2, 27, "經辦簽章："),
    makeRangeCells(sig3, 3, 11, 27),
    `<c r="M${sig3}" s="28"/>`,
  ].join("");
  sheetRows.push(`    <row r="${sig3}" ht="48" customHeight="1">${sig3Cells}</row>`);

  const mergeCells = [
    `A1:M1`,
    `A${totalRow}:C${totalRow}`,
    `A${blankRow}:M${blankRow}`,
    `A${sig1}:A${sig3}`,
    `B${sig1}:C${sig1}`,
    `D${sig1}:M${sig1}`,
    `B${sig2}:C${sig2}`,
    `D${sig2}:M${sig2}`,
    `B${sig3}:C${sig3}`,
    `D${sig3}:M${sig3}`,
  ];

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews>
    <sheetView tabSelected="1" workbookViewId="0">
      <pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/>
      <selection pane="bottomLeft" activeCell="A3" sqref="A3"/>
    </sheetView>
  </sheetViews>
  <sheetFormatPr defaultRowHeight="22"/>
  <cols>
    <col min="1" max="1" width="16" customWidth="1"/>
    <col min="2" max="2" width="28" customWidth="1"/>
    <col min="3" max="3" width="4.5" customWidth="1"/>
    <col min="4" max="4" width="15" customWidth="1"/>
    <col min="5" max="5" width="15" customWidth="1"/>
    <col min="6" max="6" width="15" customWidth="1"/>
    <col min="7" max="7" width="15" customWidth="1"/>
    <col min="8" max="8" width="15" customWidth="1"/>
    <col min="9" max="9" width="15" customWidth="1"/>
    <col min="10" max="10" width="15" customWidth="1"/>
    <col min="11" max="11" width="15" customWidth="1"/>
    <col min="12" max="12" width="14" customWidth="1"/>
    <col min="13" max="13" width="14" customWidth="1"/>
  </cols>
  <sheetData>
${sheetRows.join("\n")}
  </sheetData>
  <mergeCells count="${mergeCells.length}">
    ${mergeCells.map((m) => `<mergeCell ref="${m}"/>`).join("\n    ")}
  </mergeCells>
</worksheet>`;

  // 2. 建立樣式表 styles.xml
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="4">
    <!-- 0: Regular 12pt -->
    <font><sz val="12"/><name val="微軟正黑體"/></font>
    <!-- 1: Title Bold 14pt -->
    <font><sz val="14"/><b/><name val="微軟正黑體"/><color rgb="FF000000"/></font>
    <!-- 2: Header Bold 12pt -->
    <font><sz val="12"/><b/><name val="微軟正黑體"/><color rgb="FF000000"/></font>
    <!-- 3: Total Bold 12pt -->
    <font><sz val="12"/><b/><name val="微軟正黑體"/><color rgb="FF000000"/></font>
  </fonts>
  <fills count="7">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFFFFF"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF8FAFC"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFEF3C7"/></patternFill></fill>
  </fills>
  <borders count="17">
    <!-- 0: none -->
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <!-- 1: Internal thin border -->
    <border>
      <left style="thin"><color rgb="FF000000"/></left>
      <right style="thin"><color rgb="FF000000"/></right>
      <top style="thin"><color rgb="FF000000"/></top>
      <bottom style="thin"><color rgb="FF000000"/></bottom>
      <diagonal/>
    </border>
    <!-- 2: Left edge data border (Col A) -->
    <border>
      <left style="medium"><color rgb="FF000000"/></left>
      <right style="thin"><color rgb="FF000000"/></right>
      <top style="thin"><color rgb="FF000000"/></top>
      <bottom style="thin"><color rgb="FF000000"/></bottom>
      <diagonal/>
    </border>
    <!-- 3: Right edge data border (Col M) -->
    <border>
      <left style="thin"><color rgb="FF000000"/></left>
      <right style="medium"><color rgb="FF000000"/></right>
      <top style="thin"><color rgb="FF000000"/></top>
      <bottom style="thin"><color rgb="FF000000"/></bottom>
      <diagonal/>
    </border>
    <!-- 4: Header top-left (A2) -->
    <border>
      <left style="medium"><color rgb="FF000000"/></left>
      <right style="thin"><color rgb="FF000000"/></right>
      <top style="medium"><color rgb="FF000000"/></top>
      <bottom style="thin"><color rgb="FF000000"/></bottom>
      <diagonal/>
    </border>
    <!-- 5: Header top-middle (B2~L2) -->
    <border>
      <left style="thin"><color rgb="FF000000"/></left>
      <right style="thin"><color rgb="FF000000"/></right>
      <top style="medium"><color rgb="FF000000"/></top>
      <bottom style="thin"><color rgb="FF000000"/></bottom>
      <diagonal/>
    </border>
    <!-- 6: Header top-right (M2) -->
    <border>
      <left style="thin"><color rgb="FF000000"/></left>
      <right style="medium"><color rgb="FF000000"/></right>
      <top style="medium"><color rgb="FF000000"/></top>
      <bottom style="thin"><color rgb="FF000000"/></bottom>
      <diagonal/>
    </border>
    <!-- 7: Total A (left medium, right/top/bottom thin) -->
    <border>
      <left style="medium"><color rgb="FF000000"/></left>
      <right style="thin"><color rgb="FF000000"/></right>
      <top style="thin"><color rgb="FF000000"/></top>
      <bottom style="thin"><color rgb="FF000000"/></bottom>
      <diagonal/>
    </border>
    <!-- 8: Total B~L (all thin) -->
    <border>
      <left style="thin"><color rgb="FF000000"/></left>
      <right style="thin"><color rgb="FF000000"/></right>
      <top style="thin"><color rgb="FF000000"/></top>
      <bottom style="thin"><color rgb="FF000000"/></bottom>
      <diagonal/>
    </border>
    <!-- 9: Total M (right medium, left/top/bottom thin) -->
    <border>
      <left style="thin"><color rgb="FF000000"/></left>
      <right style="medium"><color rgb="FF000000"/></right>
      <top style="thin"><color rgb="FF000000"/></top>
      <bottom style="thin"><color rgb="FF000000"/></bottom>
      <diagonal/>
    </border>
    <!-- 10: Blank row A (left medium, bottom medium, top thin, right thin) -->
    <border>
      <left style="medium"><color rgb="FF000000"/></left>
      <right style="thin"><color rgb="FF000000"/></right>
      <top style="thin"><color rgb="FF000000"/></top>
      <bottom style="medium"><color rgb="FF000000"/></bottom>
      <diagonal/>
    </border>
    <!-- 11: Blank row B~L (bottom medium, left/right/top thin) -->
    <border>
      <left style="thin"><color rgb="FF000000"/></left>
      <right style="thin"><color rgb="FF000000"/></right>
      <top style="thin"><color rgb="FF000000"/></top>
      <bottom style="medium"><color rgb="FF000000"/></bottom>
      <diagonal/>
    </border>
    <!-- 12: Blank row M (right medium, bottom medium, left/top thin) -->
    <border>
      <left style="thin"><color rgb="FF000000"/></left>
      <right style="medium"><color rgb="FF000000"/></right>
      <top style="thin"><color rgb="FF000000"/></top>
      <bottom style="medium"><color rgb="FF000000"/></bottom>
      <diagonal/>
    </border>
    <!-- 13: Sig block top (top medium, bottom thin, left/right thin) -->
    <border>
      <left style="thin"><color rgb="FF000000"/></left>
      <right style="thin"><color rgb="FF000000"/></right>
      <top style="medium"><color rgb="FF000000"/></top>
      <bottom style="thin"><color rgb="FF000000"/></bottom>
      <diagonal/>
    </border>
    <!-- 14: Sig block top-right M (top medium, right medium, left/bottom thin) -->
    <border>
      <left style="thin"><color rgb="FF000000"/></left>
      <right style="medium"><color rgb="FF000000"/></right>
      <top style="medium"><color rgb="FF000000"/></top>
      <bottom style="thin"><color rgb="FF000000"/></bottom>
      <diagonal/>
    </border>
    <!-- 15: Sig block bottom B~L (bottom medium, top/left/right thin) -->
    <border>
      <left style="thin"><color rgb="FF000000"/></left>
      <right style="thin"><color rgb="FF000000"/></right>
      <top style="thin"><color rgb="FF000000"/></top>
      <bottom style="medium"><color rgb="FF000000"/></bottom>
      <diagonal/>
    </border>
    <!-- 16: Sig block bottom-right M (bottom medium, right medium, top/left thin) -->
    <border>
      <left style="thin"><color rgb="FF000000"/></left>
      <right style="medium"><color rgb="FF000000"/></right>
      <top style="thin"><color rgb="FF000000"/></top>
      <bottom style="medium"><color rgb="FF000000"/></bottom>
      <diagonal/>
    </border>
  </borders>
  <cellXfs count="29">
    <!-- 0: default -->
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
    <!-- 1: Title (A1) 14pt bold -->
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" applyFont="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center"/>
    </xf>
    <!-- 2: Data text center - internal -->
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyFont="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center"/>
    </xf>
    <!-- 3: Data text left - internal -->
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyFont="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="left" vertical="center"/>
    </xf>
    <!-- 4: Data number right - internal -->
    <xf numFmtId="1" fontId="0" fillId="0" borderId="1" applyFont="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="right" vertical="center"/>
    </xf>
    <!-- 5: Data number bold right - internal -->
    <xf numFmtId="1" fontId="3" fillId="0" borderId="1" applyFont="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="right" vertical="center"/>
    </xf>
    <!-- 6: Data text center - left edge -->
    <xf numFmtId="0" fontId="0" fillId="0" borderId="2" applyFont="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center"/>
    </xf>
    <!-- 7: Data number bold right - right edge -->
    <xf numFmtId="1" fontId="3" fillId="0" borderId="3" applyFont="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="right" vertical="center"/>
    </xf>
    <!-- 8: Header White - top-left -->
    <xf numFmtId="0" fontId="2" fillId="2" borderId="4" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center" wrapText="1"/>
    </xf>
    <!-- 9: Header White - top-middle -->
    <xf numFmtId="0" fontId="2" fillId="2" borderId="5" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center" wrapText="1"/>
    </xf>
    <!-- 10: Header Light Blue - top-middle -->
    <xf numFmtId="0" fontId="2" fillId="3" borderId="5" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center" wrapText="1"/>
    </xf>
    <!-- 11: Header Light Yellow - top-middle -->
    <xf numFmtId="0" fontId="2" fillId="4" borderId="5" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center" wrapText="1"/>
    </xf>
    <!-- 12: Header Light Blue - top-right -->
    <xf numFmtId="0" fontId="2" fillId="3" borderId="6" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center" wrapText="1"/>
    </xf>
    <!-- 13: Total label center - left edge -->
    <xf numFmtId="0" fontId="3" fillId="6" borderId="7" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center"/>
    </xf>
    <!-- 14: Total label center - middle -->
    <xf numFmtId="0" fontId="3" fillId="6" borderId="8" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center"/>
    </xf>
    <!-- 15: Total number right - middle -->
    <xf numFmtId="1" fontId="3" fillId="6" borderId="8" applyFont="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="right" vertical="center"/>
    </xf>
    <!-- 16: Total number right - right edge -->
    <xf numFmtId="1" fontId="3" fillId="6" borderId="9" applyFont="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="right" vertical="center"/>
    </xf>
    <!-- 17: Blank row A (left medium, bottom medium) -->
    <xf numFmtId="0" fontId="0" fillId="0" borderId="10" applyBorder="1"/>
    <!-- 18: Blank row B~L (bottom medium) -->
    <xf numFmtId="0" fontId="0" fillId="0" borderId="11" applyBorder="1"/>
    <!-- 19: Blank row M (right medium, bottom medium) -->
    <xf numFmtId="0" fontId="0" fillId="0" borderId="12" applyBorder="1"/>
    <!-- 20: Sig block A (sigRow1: top medium, left medium, right/bottom thin) -->
    <xf numFmtId="0" fontId="0" fillId="0" borderId="4" applyFont="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center"/>
    </xf>
    <!-- 21: Sig block B~L (sigRow1: top medium, bottom/left/right thin) -->
    <xf numFmtId="0" fontId="0" fillId="0" borderId="13" applyFont="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center"/>
    </xf>
    <!-- 22: Sig block M (sigRow1: top medium, right medium, left/bottom thin) -->
    <xf numFmtId="0" fontId="0" fillId="0" borderId="14" applyBorder="1"/>
    <!-- 23: Sig block A (sigRow2: left medium, right/top/bottom thin) -->
    <xf numFmtId="0" fontId="0" fillId="0" borderId="2" applyBorder="1"/>
    <!-- 24: Sig block B~L (sigRow2: all thin) -->
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyFont="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center"/>
    </xf>
    <!-- 25: Sig block M (sigRow2: right medium, left/top/bottom thin) -->
    <xf numFmtId="0" fontId="0" fillId="0" borderId="3" applyBorder="1"/>
    <!-- 26: Sig block A (sigRow3: left medium, bottom medium, right/top thin) -->
    <xf numFmtId="0" fontId="0" fillId="0" borderId="10" applyBorder="1"/>
    <!-- 27: Sig block B~L (sigRow3: bottom medium, top/left/right thin) -->
    <xf numFmtId="0" fontId="0" fillId="0" borderId="15" applyFont="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center"/>
    </xf>
    <!-- 28: Sig block M (sigRow3: bottom medium, right medium, top/left thin) -->
    <xf numFmtId="0" fontId="0" fillId="0" borderId="16" applyBorder="1"/>
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
    <sheet name="制服庫存簽核表" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;

  return zipSync({
    "[Content_Types].xml": strToU8(contentTypesXml),
    "_rels/.rels": strToU8(relsXml),
    "xl/workbook.xml": strToU8(workbookXml),
    "xl/styles.xml": strToU8(stylesXml),
    "xl/_rels/workbook.xml.rels": strToU8(workbookRelsXml),
    "xl/worksheets/sheet1.xml": strToU8(sheetXml),
  });
}

/**
 * 觸發瀏覽器下載 XLSX 檔案
 */
export function downloadInventoryAuditXlsx(data: Uint8Array, filename: string): void {
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
