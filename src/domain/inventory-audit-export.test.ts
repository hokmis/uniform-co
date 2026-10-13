import { describe, expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { generateInventoryAuditXlsx, type InventoryAuditRow, type InventoryAuditExportOptions } from "./inventory-audit-export";

describe("generateInventoryAuditXlsx", () => {
  it("generates a valid xlsx binary with proper header and rows", () => {
    const rows: InventoryAuditRow[] = [
      {
        itemId: "item-1",
        itemCode: "U-TSHIRT-L",
        itemName: "照服夏季短袖上衣",
        size: "L",
        unit: "件",
        hrOpening: 10,
        issueQty: 5,
        increaseQty: 2,
        replenishQty: 0,
        hrOnHand: 7,
        genOpening: 50,
        genIssueQty: 2,
        genOnHand: 48,
        combinedOnHand: 55,
        erpOnHand: 55,
      },
      {
        itemId: "item-2",
        itemCode: "U-TSHIRT-M",
        itemName: "照服夏季短袖上衣",
        size: "M",
        unit: "件",
        hrOpening: 20,
        issueQty: 10,
        increaseQty: 0,
        replenishQty: 5,
        hrOnHand: 15,
        genOpening: 60,
        genIssueQty: 5,
        genOnHand: 55,
        combinedOnHand: 70,
        erpOnHand: 70,
      },
    ];

    const options: InventoryAuditExportOptions = {
      year: 2026,
      month: 10,
      prevMonth: 9,
      startDate: "2026-09-21",
      endDate: "2026-10-20",
    };

    const result = generateInventoryAuditXlsx(rows, options);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBeGreaterThan(100);

    // 檢查 ZIP PK 檔頭
    expect(result[0]).toBe(0x50); // P
    expect(result[1]).toBe(0x4b); // K

    // 解壓縮驗證內部 XML 結構與標籤正確性
    const unzipped = unzipSync(result);
    expect(unzipped["xl/styles.xml"]).toBeDefined();
    expect(unzipped["xl/worksheets/sheet1.xml"]).toBeDefined();
    expect(unzipped["xl/workbook.xml"]).toBeDefined();
    expect(unzipped["[Content_Types].xml"]).toBeDefined();

    const stylesXml = strFromU8(unzipped["xl/styles.xml"]);
    const sheetXml = strFromU8(unzipped["xl/worksheets/sheet1.xml"]);

    // 驗證 styles.xml 不存在語法損毀的 </fgColor></fill> 標籤
    expect(stylesXml).not.toContain("</fgColor></fill>");
    expect(stylesXml).toContain('<fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/></patternFill></fill>');
    expect(stylesXml).toContain('<fill><patternFill patternType="solid"><fgColor rgb="FFFFF2CC"/></patternFill></fill>');

    // 驗證標題字型大小為 14pt，其餘字型為 12pt
    expect(stylesXml).toContain('<sz val="14"/>');
    expect(stylesXml).toContain('<sz val="12"/>');
    expect(stylesXml).not.toContain('<sz val="11"/>');
    expect(stylesXml).not.toContain('<sz val="15"/>');
    expect(stylesXml).not.toContain('<sz val="10"/>');

    // 驗證外框線包含 medium 粗外框
    expect(stylesXml).toContain('style="medium"');

    // 驗證欄寬設定 (B欄: 20.6, C欄: 4.5, D~M欄: 10.6)
    expect(sheetXml).toContain('<col min="2" max="2" width="20.6" customWidth="1"/>');
    expect(sheetXml).toContain('<col min="3" max="3" width="4.5" customWidth="1"/>');
    expect(sheetXml).toContain('<col min="4" max="4" width="10.6" customWidth="1"/>');
    expect(sheetXml).toContain('<col min="13" max="13" width="10.6" customWidth="1"/>');

    // 驗證 D2 欄位文字已改為總倉庫存
    expect(sheetXml).toContain('總倉庫存&#10;(9月末存)&#10;(盤點值)');

    // 驗證合計處改為總計
    expect(sheetXml).toContain('總計');

    // 驗證事務組簽核與簽章欄位
    expect(sheetXml).toContain('事務組簽核');
    expect(sheetXml).toContain('主管簽章：');
    expect(sheetXml).toContain('覆核簽章：');
    expect(sheetXml).toContain('經辦簽章：');

    // 驗證總計列與簽核列使用 fontId="1" (14pt bold)
    expect(stylesXml).toMatch(/<!-- 13: Total label[\s\S]*?fontId="1"/);
    expect(stylesXml).toMatch(/<!-- 20: Sig block A[\s\S]*?fontId="1"/);
    expect(stylesXml).toMatch(/<!-- 21: Sig block B~L[\s\S]*?fontId="1"/);
    expect(stylesXml).toMatch(/<!-- 24: Sig block B~L[\s\S]*?fontId="1"/);
    expect(stylesXml).toMatch(/<!-- 27: Sig block B~L[\s\S]*?fontId="1"/);

    // 驗證工作表包含表頭樣式參照 (s="8", s="9", s="10", s="11", s="12")
    expect(sheetXml).toContain('s="8"');  // A2 (白底左上角)
    expect(sheetXml).toContain('s="9"');  // B2, C2 (白底頂部中間)
    expect(sheetXml).toContain('s="10"'); // D2, H2, I2, K2, L2 (粉藍底頂部中間)
    expect(sheetXml).toContain('s="11"'); // E2, F2, G2, J2 (粉黃底頂部中間)
    expect(sheetXml).toContain('s="12"'); // M2 (粉藍底右上角)
    expect(sheetXml).toContain('xml:space="preserve"');
  });
});
