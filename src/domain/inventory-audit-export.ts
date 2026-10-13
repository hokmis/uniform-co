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
    { text: "品   號", style: 20 },
    { text: "品   名", style: 20 },
    { text: "規格", style: 20 },
    { text: `人資庫存&#10;(${options.prevMonth}月末存)`, style: 21 },
    { text: `${options.month}月發放量&#10;(人資表)&#10;(鼎新值)&#10;(貼上值)`, style: 22 },
    { text: `${options.month}月增庫量&#10;(含增額)&#10;(人資表)&#10;(貼上值)`, style: 22 },
    { text: `${options.month}月補貨量&#10;(含增額)&#10;(人資表)&#10;(貼上值)`, style: 22 },
    { text: `人資庫存&#10;(${options.month}月末存)`, style: 21 },
    { text: `總倉庫存&#10;(${options.prevMonth}月末存)&#10;(盤點值)`, style: 20 },
    { text: `${options.month}月發貨量&#10;(含增額)&#10;(人資表)&#10;(貼上值)`, style: 22 },
    { text: `總倉庫存&#10;(${options.month}月末存)&#10;(盤點值)`, style: 21 },
    { text: "合併庫存", style: 20 },
    { text: "ERP庫存", style: 20 },
  ];

  const colLetters = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M"];

  // 1. 建立工作表 XML
  const sheetRows: string[] = [];

  // Row 1: 標題列（合併 A1:M1）
  sheetRows.push(
    `    <row r="1" ht="36" customHeight="1">` +
    `<c r="A1" s="1" t="inlineStr"><is><t>${escapeXml(title)}</t></is></c>` +
    colLetters.slice(1).map((col) => `<c r="${col}1" s="1"/>`).join("") +
    `</row>`
  );

  // Row 2: 表頭列
  sheetRows.push(
    `    <row r="2" ht="62" customHeight="1">` +
    headerDefs.map((h, i) => `<c r="${colLetters[i]}2" s="${h.style}" t="inlineStr"><is><t>${h.text}</t></is></c>`).join("") +
    `</row>`
  );

  // Row 3 ~ Row N: 資料列
  let currentRow = 3;
  for (const r of sortedRows) {
    const rowIdx = currentRow;
    const cells: string[] = [
      // A: 品號
      `<c r="A${rowIdx}" s="3" t="inlineStr"><is><t>${escapeXml(r.itemCode)}</t></is></c>`,
      // B: 品名
      `<c r="B${rowIdx}" s="4" t="inlineStr"><is><t>${escapeXml(r.itemName)}</t></is></c>`,
      // C: 規格
      `<c r="C${rowIdx}" s="3" t="inlineStr"><is><t>${escapeXml(r.size || "—")}</t></is></c>`,
      // D: 人資庫存((上月)月末存)
      `<c r="D${rowIdx}" s="5"><v>${r.hrOpening}</v></c>`,
      // E: (本月)月發放量
      `<c r="E${rowIdx}" s="5"><v>${r.issueQty}</v></c>`,
      // F: (本月)月增庫量
      `<c r="F${rowIdx}" s="5"><v>${r.increaseQty}</v></c>`,
      // G: (本月)月補貨量
      `<c r="G${rowIdx}" s="5"><v>${r.replenishQty}</v></c>`,
      // H: 人資庫存((本月)月末存) = D - E + F + G
      `<c r="H${rowIdx}" s="5"><f>D${rowIdx}-E${rowIdx}+F${rowIdx}+G${rowIdx}</f><v>${r.hrOnHand}</v></c>`,
      // I: 總倉庫存((上月)月末存)
      `<c r="I${rowIdx}" s="5"><v>${r.genOpening}</v></c>`,
      // J: (本月)月發貨量 = F + G
      `<c r="J${rowIdx}" s="5"><f>F${rowIdx}+G${rowIdx}</f><v>${r.genIssueQty}</v></c>`,
      // K: 總倉庫存((本月)月末存) = I - J
      `<c r="K${rowIdx}" s="5"><f>I${rowIdx}-J${rowIdx}</f><v>${r.genOnHand}</v></c>`,
      // L: 合併庫存 = H + K
      `<c r="L${rowIdx}" s="6"><f>H${rowIdx}+K${rowIdx}</f><v>${r.combinedOnHand}</v></c>`,
      // M: ERP庫存 = L
      `<c r="M${rowIdx}" s="6"><f>L${rowIdx}</f><v>${r.erpOnHand}</v></c>`,
    ];
    sheetRows.push(`    <row r="${rowIdx}" ht="20" customHeight="1">${cells.join("")}</row>`);
    currentRow++;
  }

  // 合計列（Row currentRow）
  const totalRow = currentRow;
  const lastDataRow = totalRow - 1;
  const totalCells: string[] = [
    `<c r="A${totalRow}" s="7" t="inlineStr"><is><t>合計</t></is></c>`,
    `<c r="B${totalRow}" s="7"/>`,
    `<c r="C${totalRow}" s="7"/>`,
  ];

  for (let c = 3; c < colLetters.length; c++) {
    const col = colLetters[c];
    if (sortedRows.length > 0) {
      totalCells.push(`<c r="${col}${totalRow}" s="8"><f>SUM(${col}3:${col}${lastDataRow})</f></c>`);
    } else {
      totalCells.push(`<c r="${col}${totalRow}" s="8"><v>0</v></c>`);
    }
  }
  sheetRows.push(`    <row r="${totalRow}" ht="22" customHeight="1">${totalCells.join("")}</row>`);

  const mergeCells = [
    `    <mergeCell ref="A1:M1"/>`,
    `    <mergeCell ref="A${totalRow}:C${totalRow}"/>`,
  ];

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheetViews>
    <sheetView tabSelected="1" workbookViewId="0">
      <pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/>
    </sheetView>
  </sheetViews>
  <sheetFormatPr defaultRowHeight="20"/>
  <cols>
    <col min="1" max="1" width="14" customWidth="1"/>
    <col min="2" max="2" width="26" customWidth="1"/>
    <col min="3" max="3" width="9" customWidth="1"/>
    <col min="4" max="4" width="14" customWidth="1"/>
    <col min="5" max="5" width="14" customWidth="1"/>
    <col min="6" max="6" width="14" customWidth="1"/>
    <col min="7" max="7" width="14" customWidth="1"/>
    <col min="8" max="8" width="14" customWidth="1"/>
    <col min="9" max="9" width="14" customWidth="1"/>
    <col min="10" max="10" width="14" customWidth="1"/>
    <col min="11" max="11" width="14" customWidth="1"/>
    <col min="12" max="12" width="12" customWidth="1"/>
    <col min="13" max="13" width="12" customWidth="1"/>
  </cols>
  <sheetData>
${sheetRows.join("\n")}
  </sheetData>
  <mergeCells count="${mergeCells.length}">
${mergeCells.join("\n")}
  </mergeCells>
</worksheet>`;

  // 2. 建立樣式表 styles.xml
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="4">
    <font><sz val="11"/><name val="微軟正黑體"/></font>
    <font><b/><sz val="15"/><name val="微軟正黑體"/><color rgb="FF000000"/></font>
    <font><sz val="11"/><name val="微軟正黑體"/><color rgb="FF000000"/></font>
    <font><b/><sz val="11"/><name val="微軟正黑體"/><color rgb="FF000000"/></font>
  </fonts>
  <fills count="7">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFFFFF"/></fgColor></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/></fgColor></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/></fgColor></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF8FAFC"/></fgColor></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFEF3C7"/></fgColor></fill>
  </fills>
  <borders count="4">
    <border><left/><right/><top/><bottom/></border>
    <!-- 1: Data cell thin border (black) -->
    <border>
      <left style="thin"><color rgb="FF000000"/></left>
      <right style="thin"><color rgb="FF000000"/></right>
      <top style="thin"><color rgb="FF000000"/></top>
      <bottom style="thin"><color rgb="FF000000"/></bottom>
    </border>
    <!-- 2: Total bottom double border -->
    <border>
      <left style="thin"><color rgb="FF000000"/></left>
      <right style="thin"><color rgb="FF000000"/></right>
      <top style="thin"><color rgb="FF000000"/></top>
      <bottom style="double"><color rgb="FF000000"/></bottom>
    </border>
    <!-- 3: Outer/Header border -->
    <border>
      <left style="thin"><color rgb="FF000000"/></left>
      <right style="thin"><color rgb="FF000000"/></right>
      <top style="thin"><color rgb="FF000000"/></top>
      <bottom style="thin"><color rgb="FF000000"/></bottom>
    </border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="23">
    <!-- 0: default -->
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <!-- 1: Title (A1) -->
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center"/>
    </xf>
    <!-- 2: Old Header (Row 2 legacy) -->
    <xf numFmtId="0" fontId="2" fillId="2" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center" wrapText="1"/>
    </xf>
    <!-- 3: Data text center -->
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyFont="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center"/>
    </xf>
    <!-- 4: Data text left -->
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyFont="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="left" vertical="center"/>
    </xf>
    <!-- 5: Data number right -->
    <xf numFmtId="1" fontId="0" fillId="0" borderId="1" applyFont="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="right" vertical="center"/>
    </xf>
    <!-- 6: Data number bold right (合併庫存, ERP庫存) -->
    <xf numFmtId="1" fontId="3" fillId="0" borderId="1" applyFont="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="right" vertical="center"/>
    </xf>
    <!-- 7: Total label center -->
    <xf numFmtId="0" fontId="3" fillId="6" borderId="2" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center"/>
    </xf>
    <!-- 8: Total number right -->
    <xf numFmtId="1" fontId="3" fillId="6" borderId="2" applyFont="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="right" vertical="center"/>
    </xf>
    <!-- 9~19: reserved -->
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <!-- 20: Header White background (A, B, C, I, L, M) -->
    <xf numFmtId="0" fontId="2" fillId="2" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center" wrapText="1"/>
    </xf>
    <!-- 21: Header Light Blue background (D, H, K: #DDEBF7) -->
    <xf numFmtId="0" fontId="2" fillId="3" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center" wrapText="1"/>
    </xf>
    <!-- 22: Header Light Yellow background (E, F, G, J: #FFF2CC) -->
    <xf numFmtId="0" fontId="2" fillId="4" borderId="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">
      <alignment horizontal="center" vertical="center" wrapText="1"/>
    </xf>
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
