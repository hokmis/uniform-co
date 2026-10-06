import { describe, expect, it } from "vitest";
import {
  ORDERED_INSTITUTION_NAMES,
  ALLOWED_INSTITUTION_NAMES,
  resolveInstitutionInfo,
  buildPivotTableData,
  generatePivotXlsx,
  getExcelColumnName,
  getItemCategory,
  comparePivotRows,
  getSizeRank,
  getBaseItemName,
  ORDERED_ITEM_CATEGORIES,
  getItemCategoryRank,
  type RawIssueLineInput,
} from "./hr-request-pivot-export";
import { unzipSync } from "fflate";

describe("hr-request-pivot-export", () => {
  it("strictly follows the 22 ordered institutions requested by the user", () => {
    const expected = [
      "福", "氣", "心", "平", "安",
      "春", "日", "照", "風", "景",
      "山", "泉", "水", "清", "涼",
      "護家", "含笑", "法人", "一館", "二館", "三館", "幼"
    ];
    expect(ORDERED_INSTITUTION_NAMES).toEqual(expected);
  });

  it("normalizes institution codes and names correctly", () => {
    expect(resolveInstitutionInfo("8C清福").shortName).toBe("福");
    expect(resolveInstitutionInfo("C8").shortName).toBe("福");
    expect(resolveInstitutionInfo("7C清氣").shortName).toBe("氣");
    expect(resolveInstitutionInfo("C7").shortName).toBe("氣");
    expect(resolveInstitutionInfo("2CD清護").shortName).toBe("護家");
    expect(resolveInstitutionInfo("CD2").shortName).toBe("護家");
    expect(resolveInstitutionInfo("47091980").shortName).toBe("含笑");
    expect(resolveInstitutionInfo("含笑").shortName).toBe("含笑");
    expect(resolveInstitutionInfo("清福法人").shortName).toBe("法人");
    expect(resolveInstitutionInfo("L1").shortName).toBe("法人");
    expect(resolveInstitutionInfo("一館").shortName).toBe("一館");
    expect(resolveInstitutionInfo("清福幼兒園").shortName).toBe("幼");
    expect(resolveInstitutionInfo("B2").shortName).toBe("幼");

    // 驗證代碼映射：含笑只有 47091980，三館只有 L23
    expect(resolveInstitutionInfo("含笑").code).toBe("47091980");
    expect(resolveInstitutionInfo("47091980").code).toBe("47091980");
    expect(resolveInstitutionInfo("三館").code).toBe("L23");
    expect(resolveInstitutionInfo("L23").code).toBe("L23");
  });

  it("aggregates raw issue lines into pivot rows with correct quantities", () => {
    const lines: RawIssueLineInput[] = [
      { itemCode: "UNT0102", itemName: "精緻夏季", size: "2L", institutionCodeOrName: "8C清福", quantity: 2 },
      { itemCode: "UNT0102", itemName: "精緻夏季", size: "2L", institutionCodeOrName: "8C清福", quantity: 3 },
      { itemCode: "UNT0102", itemName: "精緻夏季", size: "2L", institutionCodeOrName: "7C清氣", quantity: 1 },
      { itemCode: "UNT0102", itemName: "精緻夏季", size: "S", institutionCodeOrName: "清福法人", quantity: 5 },
      { itemCode: "UTW01M", itemName: "精緻冬季", size: "M", institutionCodeOrName: "含笑", quantity: 4 },
    ];

    const stockMap = new Map([
      ["UNT0102", { itemCode: "UNT0102", onHand: 50, increaseQuantity: 10 }],
    ]);

    const result = buildPivotTableData(lines, stockMap);

    // 22 個指定機構排前
    expect(result.institutions.slice(0, 5).map((i) => i.shortName)).toEqual(["福", "氣", "心", "平", "安"]);

    // 共有 3 列 (UNT0102 2L, UNT0102 S, UTW01M M)
    expect(result.rows.length).toBe(3);

    const unt2l = result.rows.find((r) => r.itemCode === "UNT0102" && r.size === "2L")!;
    expect(unt2l).toBeDefined();
    expect(unt2l.quantitiesByInstitution["福"]).toBe(5);
    expect(unt2l.quantitiesByInstitution["氣"]).toBe(1);
    expect(unt2l.totalIssued).toBe(6);
    expect(unt2l.onHand).toBe(50);
    expect(unt2l.increaseQuantity).toBe(10);

    const untS = result.rows.find((r) => r.itemCode === "UNT0102" && r.size === "S")!;
    expect(untS.quantitiesByInstitution["法人"]).toBe(5);
    expect(untS.totalIssued).toBe(5);

    expect(result.grandTotal).toBe(15);
    expect(result.totalByInstitution["福"]).toBe(5);
    expect(result.totalByInstitution["氣"]).toBe(1);
    expect(result.totalByInstitution["法人"]).toBe(5);
    expect(result.totalByInstitution["含笑"]).toBe(4);
  });

  it("converts column indices to Excel column letters", () => {
    expect(getExcelColumnName(1)).toBe("A");
    expect(getExcelColumnName(26)).toBe("Z");
    expect(getExcelColumnName(27)).toBe("AA");
    expect(getExcelColumnName(28)).toBe("AB");
  });

  it("generates a valid XLSX ZIP buffer with required OpenXML structures", () => {
    const lines: RawIssueLineInput[] = [
      { itemCode: "UNT0102", itemName: "精緻夏季", size: "2L", institutionCodeOrName: "8C清福", quantity: 2 },
    ];
    const pivotData = buildPivotTableData(lines);
    const xlsxBytes = generatePivotXlsx(pivotData, {
      title: "平日制服領用表",
      dateRangeLabel: "2026-01-21 ～ 2026-02-20",
    });

    expect(xlsxBytes).toBeInstanceOf(Uint8Array);
    expect(xlsxBytes.length).toBeGreaterThan(100);

    // 解壓縮驗證內部結構
    const unzipped = unzipSync(xlsxBytes);
    expect(unzipped["[Content_Types].xml"]).toBeDefined();
    expect(unzipped["xl/workbook.xml"]).toBeDefined();
    expect(unzipped["xl/worksheets/sheet1.xml"]).toBeDefined();

    const sheetContent = new TextDecoder().decode(unzipped["xl/worksheets/sheet1.xml"]);
    // 驗證第一列標題格式：平日制服領用表 ( 2026-01-21 ～ 2026-02-20 )
    expect(sheetContent).toContain("平日制服領用表 ( 2026-01-21 ～ 2026-02-20 )");
    expect(sheetContent).toContain('<c r="A1" t="inlineStr" s="1">');
    expect(sheetContent).toContain('<c r="H1" t="inlineStr" s="2">');
    expect(sheetContent).not.toContain('<c r="E1"');
    expect(sheetContent).toContain('<mergeCell ref="A1:G1"/>');
    expect(sheetContent).toContain("UNT0102");
    expect(sheetContent).toContain("精緻夏季");
    expect(sheetContent).toContain("SUM(");
  });

  it("includes replenishment and request increase quantities in the replenishment column (F)", () => {
    // 情境：
    // 1. UNT0102 有請領發放（3件），且有隨單增庫（15件）
    // 2. REP9999 只有額外補庫申請（20件），當期無人請領發放
    const lines: RawIssueLineInput[] = [
      { itemCode: "UNT0102", itemName: "短袖上衣", size: "L", institutionCodeOrName: "8C清福", quantity: 3 },
    ];

    const stockMap = new Map([
      ["UNT0102", { itemCode: "UNT0102", itemName: "短袖上衣", onHand: 10, increaseQuantity: 15 }],
      ["REP9999", { itemCode: "REP9999", itemName: "額外補庫長褲", unit: "件", onHand: 0, increaseQuantity: 20 }],
    ]);

    const pivotData = buildPivotTableData(lines, stockMap);

    // 應該要有 2 列（UNT0102 與純補庫的 REP9999）
    expect(pivotData.rows.length).toBe(2);

    const untRow = pivotData.rows.find((r) => r.itemCode === "UNT0102")!;
    expect(untRow).toBeDefined();
    expect(untRow.totalIssued).toBe(3);
    expect(untRow.increaseQuantity).toBe(15);

    const repRow = pivotData.rows.find((r) => r.itemCode === "REP9999")!;
    expect(repRow).toBeDefined();
    expect(repRow.itemName).toBe("額外補庫長褲");
    expect(repRow.totalIssued).toBe(0);
    expect(repRow.increaseQuantity).toBe(20);

    // 產生 Excel 並解開檢查
    const xlsxBytes = generatePivotXlsx(pivotData, {
      title: "平日制服領用與增庫統計表",
      dateRangeLabel: "2026-08-21 ～ 2026-09-20",
    });

    const unzipped = unzipSync(xlsxBytes);
    const sheetContent = new TextDecoder().decode(unzipped["xl/worksheets/sheet1.xml"]);

    // 檢查欄位表頭包含「庫增量」與「F」
    expect(sheetContent).toContain("庫增量");
    expect(sheetContent).toContain("<is><t>F</t></is>");

    // 檢查表頭 G=B+F 與 I=C+E+G+H
    expect(sheetContent).toContain("<is><t>G=B+F</t></is>");
    expect(sheetContent).toContain("<is><t>I=C+E+G+H</t></is>");

    // 檢查品項與增庫量數值 15 與 20
    expect(sheetContent).toContain("REP9999");
    expect(sheetContent).toContain("額外補庫長褲");
    expect(sheetContent).toContain("<v>15</v>");
    expect(sheetContent).toContain("<v>20</v>");
    // 檢查合計列含有 SUM 公式
    expect(sheetContent).toContain("<v>35</v>"); // 15 + 20
  });

  it("exports ending quantity with formula I=C+E+G+H and issue quantity G=B+F", () => {
    const lines: RawIssueLineInput[] = [
      { itemCode: "UNT0102", itemName: "短袖上衣", size: "L", institutionCodeOrName: "8C清福", quantity: 5 },
    ];
    const stockMap = new Map([
      ["UNT0102", { itemCode: "UNT0102", onHand: 100, increaseQuantity: 20 }],
    ]);

    const pivotData = buildPivotTableData(lines, stockMap);
    const xlsxBytes = generatePivotXlsx(pivotData, {
      title: "平日制服領用統計表",
    });

    const unzipped = unzipSync(xlsxBytes);
    const sheetContent = new TextDecoder().decode(unzipped["xl/worksheets/sheet1.xml"]);

    // 驗證期末量表頭（已移至 Row 5 符號列）
    expect(sheetContent).toContain("<is><t>I=C+E+G+H</t></is>");
    expect(sheetContent).toContain("<is><t>G=B+F</t></is>");

    // 驗證期末量實際公式包含 C + E + G + H 欄位相加 (Row 6)
    // 22 個機構 + 5 個左側欄位 = 第 27 欄 (AA) 為最後一個機構
    // sumCol (B) = AB, balanceCol (C) = AC, damageCol (D) = AD, estimateCol (E) = AE, remark = AF, replenishmentCol (F) = AG, issueCol (G) = AH, returnCol (H) = AI, finalCol (I) = AJ
    expect(sheetContent).toContain("<f>AC6+AE6+AH6+AI6</f>");
    // 驗證期末量計算值 (100 - 5) + (5 + 20) = 120
    expect(sheetContent).toContain("<v>120</v>");
    // 驗證本次發放量公式 G=B+F (AB6+AG6)
    expect(sheetContent).toContain("<f>AB6+AG6</f>");
    expect(sheetContent).toContain("<v>25</v>");
  });

  it("exports all catalog items even when stock and issued quantities are zero", () => {
    // 即使沒有任何領用明細，且庫存為 0，只要在 stockMap 中，皆會完整輸出
    const lines: RawIssueLineInput[] = [];
    const stockMap = new Map([
      ["UKS01S", { itemCode: "UKS01S", itemName: "幼兒園夏季上衣-S", size: "S", onHand: 0, increaseQuantity: 0 }],
      ["UKS01M", { itemCode: "UKS01M", itemName: "幼兒園夏季上衣-M", size: "M", onHand: 2, increaseQuantity: 0 }],
    ]);

    const pivotData = buildPivotTableData(lines, stockMap);
    expect(pivotData.rows.length).toBe(2);
    expect(pivotData.rows[0].itemCode).toBe("UKS01M");
    expect(pivotData.rows[1].itemCode).toBe("UKS01S");
    expect(pivotData.rows[1].onHand).toBe(0);
    expect(pivotData.rows[1].totalIssued).toBe(0);
  });

  it("renders bottom signature boxes and notice note in OpenXML", () => {
    const lines: RawIssueLineInput[] = [
      { itemCode: "UKS01M", itemName: "幼兒園夏季上衣-M", size: "M", institutionCodeOrName: "8C清福", quantity: 2 },
    ];
    const pivotData = buildPivotTableData(lines);
    const xlsxBytes = generatePivotXlsx(pivotData, {
      title: "平日制服領用表",
    });

    const unzipped = unzipSync(xlsxBytes);
    const sheetContent = new TextDecoder().decode(unzipped["xl/worksheets/sheet1.xml"]);

    // 驗證附註
    expect(sheetContent).toContain("註：正本提供事務組簽核後，繳交財務室稽核留存。");
    // 驗證人資室簽核項目
    expect(sheetContent).toContain("人&#10;資&#10;室");
    expect(sheetContent).toContain("主管核准：");
    expect(sheetContent).toContain("覆核：");
    expect(sheetContent).toContain("人資經辦：許雅婷");
    // 驗證事務組簽核項目
    expect(sheetContent).toContain("事&#10;務&#10;組");
    expect(sheetContent).toContain("事務經辦：");
    // 驗證右側人資簽收
    expect(sheetContent).toContain("人資簽收&#10;(制服領貨)");
    // 驗證簽核合併儲存格
    expect(sheetContent).toMatch(/<mergeCell ref="B\d+:G\d+"\/>/);
    expect(sheetContent).toMatch(/<mergeCell ref="H\d+:L\d+"\/>/);
    expect(sheetContent).toMatch(/<mergeCell ref="M\d+:S\d+"\/>/);
  });

  it("merges rows 2-4 for fixed & summary headers, shifts symbols to row 5, and sums correctly in total row", () => {
    const lines: RawIssueLineInput[] = [
      { itemCode: "UNT01", itemName: "上衣", size: "L", institutionCodeOrName: "8C清福", quantity: 3 },
      { itemCode: "UNT02", itemName: "短褲", size: "M", institutionCodeOrName: "7C清氣", quantity: 2 },
    ];
    const stockMap = new Map([
      ["UNT01", { itemCode: "UNT01", onHand: 50, increaseQuantity: 5 }],
      ["UNT02", { itemCode: "UNT02", onHand: 30, increaseQuantity: 0 }],
    ]);

    const pivotData = buildPivotTableData(lines, stockMap);
    const xlsxBytes = generatePivotXlsx(pivotData, {
      title: "平日制服領用表",
    });

    const unzipped = unzipSync(xlsxBytes);
    const stylesContent = new TextDecoder().decode(unzipped["xl/styles.xml"]);
    const sheetContent = new TextDecoder().decode(unzipped["xl/worksheets/sheet1.xml"]);

    // 1. 樣式驗證：包含 FFE2EFDA (綠), FFFFF2CC (黃), FFFFCCFF (粉紫)
    expect(stylesContent).toContain('rgb="FFE2EFDA"');
    expect(stylesContent).toContain('rgb="FFFFF2CC"');
    expect(stylesContent).toContain('rgb="FFFFCCFF"');

    // 2. 表頭垂直合併驗證 (A2:A4 ~ E2:E4 以及右側統計欄)
    expect(sheetContent).toContain('<mergeCell ref="A2:A4"/>');
    expect(sheetContent).toContain('<mergeCell ref="B2:B4"/>');
    expect(sheetContent).toContain('<mergeCell ref="C2:C4"/>');
    expect(sheetContent).toContain('<mergeCell ref="D2:D4"/>');
    expect(sheetContent).toContain('<mergeCell ref="E2:E4"/>');
    expect(sheetContent).toContain('<mergeCell ref="AB2:AB4"/>');
    expect(sheetContent).toContain('<mergeCell ref="AC2:AC4"/>');
    expect(sheetContent).toContain('<mergeCell ref="AD2:AD4"/>');
    expect(sheetContent).toContain('<mergeCell ref="AE2:AE4"/>');
    expect(sheetContent).toContain('<mergeCell ref="AF2:AF4"/>');
    expect(sheetContent).toContain('<mergeCell ref="AG2:AG4"/>');
    expect(sheetContent).toContain('<mergeCell ref="AH2:AH4"/>');
    expect(sheetContent).toContain('<mergeCell ref="AI2:AI4"/>');
    expect(sheetContent).toContain('<mergeCell ref="AJ2:AJ4"/>');

    // 3. 表頭文字排列換行驗證
    expect(sheetContent).toMatch(/<c r="D2" t="inlineStr" s="\d+"><is><t>規&#10;格<\/t><\/is><\/c>/);
    expect(sheetContent).toMatch(/<c r="E2" t="inlineStr" s="\d+"><is><t>期&#10;初&#10;量<\/t><\/is><\/c>/);
    expect(sheetContent).toContain("<t>請領&#10;合計</t>");
    expect(sheetContent).toContain("<t>月結量&#10;(抽盤)</t>");
    expect(sheetContent).toContain("<t>事務組&#10;偶數月&#10;抽盤</t>");
    expect(sheetContent).toContain("<t>抽盤&#10;差異</t>");
    expect(sheetContent).toContain("<t>備註&#10;差異說明</t>");
    expect(sheetContent).toContain("<t>庫增量</t>");
    expect(sheetContent).toContain("<t>本次&#10;發放量</t>");
    expect(sheetContent).toContain("<t>冬夏&#10;領退量</t>");
    expect(sheetContent).toContain("<t>期末量&#10;(下期期初)</t>");

    // 4. Row 5 符號列驗證
    expect(sheetContent).toMatch(/<c r="E5" t="inlineStr" s="\d+"><is><t>A<\/t><\/is><\/c>/);
    expect(sheetContent).toMatch(/<c r="AB5" t="inlineStr" s="\d+"><is><t>B<\/t><\/is><\/c>/);
    expect(sheetContent).toMatch(/<c r="AC5" t="inlineStr" s="\d+"><is><t>C=A-B<\/t><\/is><\/c>/);
    expect(sheetContent).toMatch(/<c r="AJ5" t="inlineStr" s="\d+"><is><t>I=C\+E\+G\+H<\/t><\/is><\/c>/);

    // 5. 資料列從 Row 6 開始
    expect(sheetContent).toMatch(/<c r="E6" s="\d+"><v>50<\/v><\/c>/);
    expect(sheetContent).toContain('<c r="AC6" s="');
    expect(sheetContent).toContain('<c r="AJ6" s="');

    // 6. 合計列（Row 8）從期初量至期末量全數計算合計量與 SUM 公式 (E6:E7)
    expect(sheetContent).toMatch(/<c r="E8" s="\d+"><f>SUM\(E6:E7\)<\/f><v>80<\/v><\/c>/);
    expect(sheetContent).toMatch(/<c r="AB8" s="\d+"><f>SUM\(AB6:AB7\)<\/f><v>5<\/v><\/c>/);
    expect(sheetContent).toMatch(/<c r="AC8" s="\d+"><f>SUM\(AC6:AC7\)<\/f><v>75<\/v><\/c>/); // 80 - 5 = 75
    expect(sheetContent).toMatch(/<c r="AD8" s="\d+"><f>SUM\(AD6:AD7\)<\/f><\/c>/);
    expect(sheetContent).toMatch(/<c r="AE8" s="\d+"><f>SUM\(AE6:AE7\)<\/f><\/c>/);
    expect(sheetContent).toMatch(/<c r="AG8" s="\d+"><f>SUM\(AG6:AG7\)<\/f><v>5<\/v><\/c>/);
    expect(sheetContent).toMatch(/<c r="AH8" s="\d+"><f>SUM\(AH6:AH7\)<\/f><v>10<\/v><\/c>/); // 5 + 5
    expect(sheetContent).toMatch(/<c r="AI8" s="\d+"><f>SUM\(AI6:AI7\)<\/f><\/c>/);
    expect(sheetContent).toMatch(/<c r="AJ8" s="\d+"><f>SUM\(AJ6:AJ7\)<\/f><v>85<\/v><\/c>/); // 80 + 5 = 85

    // 7. 驗證樣式表中包含 medium (粗外框線)、double (底端雙框線) 與 thin 一般黑色框線 (FF000000)
    expect(stylesContent).toContain('style="medium"');
    expect(stylesContent).toContain('style="double"');
    expect(stylesContent).toContain('<left style="thin"><color rgb="FF000000"/></left>');

    // 8. 驗證字體大小：大標題改為 20pt、原 12pt 改為 13pt、A2~AM2 表頭取消粗體使用 fontId=0 (13pt normal)
    expect(stylesContent).toContain('<font><sz val="13"/><name val="微軟正黑體"/></font>');
    expect(stylesContent).toContain('<font><sz val="20"/><b/><name val="微軟正黑體"/></font>');
    expect(stylesContent).toContain('<font><sz val="13"/><b/><name val="微軟正黑體"/></font>');
    expect(stylesContent).toContain('<font><sz val="11"/><name val="微軟正黑體"/></font>');

    // 驗證 Row 2 (A2, D2, E2, AB2 等) 表頭儲存格使用 fontId="0" (無粗體)
    const a2StyleMatch = sheetContent.match(/<c r="A2" t="inlineStr" s="(\d+)">/);
    expect(a2StyleMatch).not.toBeNull();
    const a2StyleId = parseInt(a2StyleMatch![1], 10);
    // 取出對應的 xf 標籤確認其 fontId="0"
    const xfRegex = /<xf [^>]+>/g;
    const xfs: string[] = stylesContent.match(xfRegex) || [];
    expect(xfs[a2StyleId]).toContain('fontId="0"');

    // 9. 驗證 Row 2 分店區間 (F2 ~ AA2) 完整產生帶頂部粗框線樣式的儲存格，且同樣為 fontId="0"
    const f2StyleMatch = sheetContent.match(/<c r="F2" t="inlineStr" s="(\d+)">/);
    expect(f2StyleMatch).not.toBeNull();
    const f2StyleId = parseInt(f2StyleMatch![1], 10);
    expect(xfs[f2StyleId]).toContain('fontId="0"');
    expect(sheetContent).toMatch(/<c r="G2" s="\d+"\/>/);
    expect(sheetContent).toMatch(/<c r="AA2" s="\d+"\/>/);

    // 10. 驗證開啟預設縮放 64% (zoomScale="64")
    expect(sheetContent).toContain('<sheetView tabSelected="1" workbookViewId="0" zoomScale="64" zoomScaleNormal="64"/>');

    // 11. 驗證規格欄寬為 3.2，統計各欄具有自動最適大小欄寬設定與 bestFit="1"
    expect(sheetContent).toContain('<col min="4" max="4" width="3.2" customWidth="1"/>');
    expect(sheetContent).toContain('width="7.5" bestFit="1" customWidth="1"'); // 請領合計 / 抽盤差異
    expect(sheetContent).toContain('width="9" bestFit="1" customWidth="1"');   // 月結量 / 事務組抽盤
    expect(sheetContent).toContain('width="11" bestFit="1" customWidth="1"');  // 備註差異說明
    expect(sheetContent).toContain('width="8.5" bestFit="1" customWidth="1"'); // 庫增量 / 本次發放量 / 冬夏領退量
  });

  it("accurately detects category and gender transitions as requested by the user", () => {
    // 使用者指定範例驗證：
    // "照服夏季上衣-6L" 到 "照服冬季上衣-XS" 算換品項
    expect(getItemCategory("照服夏季上衣-6L", "6L")).toBe("照服夏季上衣");
    expect(getItemCategory("照服冬季上衣-XS", "XS")).toBe("照服冬季上衣");
    expect(getItemCategory("照服夏季上衣-6L", "6L")).not.toBe(getItemCategory("照服冬季上衣-XS", "XS"));

    // "照服冬季上衣-6L" 到 "照服行政冬夏褲-XS" 算換品項
    expect(getItemCategory("照服冬季上衣-6L", "6L")).toBe("照服冬季上衣");
    expect(getItemCategory("照服行政冬夏褲-XS", "XS")).toBe("照服行政冬夏褲");
    expect(getItemCategory("照服冬季上衣-6L", "6L")).not.toBe(getItemCategory("照服行政冬夏褲-XS", "XS"));

    // "照服行政冬夏褲-6L" 到 "照服中高階夏上衣-女M" 算換品項
    expect(getItemCategory("照服行政冬夏褲-6L", "6L")).toBe("照服行政冬夏褲");
    expect(getItemCategory("照服中高階夏上衣-女M", "女M")).toBe("照服中高階夏上衣-女");
    expect(getItemCategory("照服行政冬夏褲-6L", "6L")).not.toBe(getItemCategory("照服中高階夏上衣-女M", "女M"));

    // 同一品項區分出 "男" 和 "女" 並算換品項（加上底端雙框線）
    expect(getItemCategory("照服中高階夏上衣-男L", "男L")).toBe("照服中高階夏上衣-男");
    expect(getItemCategory("照服中高階夏上衣-女M", "女M")).not.toBe(getItemCategory("照服中高階夏上衣-男L", "男L"));

    // 同品項且同性別不同尺碼算相同品項
    expect(getItemCategory("照服中高階夏上衣-女M", "女M")).toBe(getItemCategory("照服中高階夏上衣-女L", "女L"));
    expect(getItemCategory("照服中高階夏上衣-男M", "男M")).toBe(getItemCategory("照服中高階夏上衣-男2L", "男2L"));
    expect(getItemCategory("照服冬季上衣-XS", "XS")).toBe(getItemCategory("照服冬季上衣-S", "S"));
    expect(getItemCategory("照服冬季上衣-S", "S")).toBe(getItemCategory("照服冬季上衣-6L", "6L"));

    // 括號形式男女品名
    expect(getItemCategory("照服中高階夏上衣(男)-M", "M")).toBe("照服中高階夏上衣(男)");
    expect(getItemCategory("照服中高階夏上衣(女)-M", "M")).toBe("照服中高階夏上衣(女)");
    expect(getItemCategory("照服中高階夏上衣(男)-M", "M")).not.toBe(getItemCategory("照服中高階夏上衣(女)-M", "M"));
  });

  it("sorts rows by itemName first, then itemCode, then size, grouping identical and similar items together", () => {
    const lines: RawIssueLineInput[] = [
      { itemCode: "ZZZ999", itemName: "照服夏季上衣-L", size: "L", institutionCodeOrName: "8C清福", quantity: 1 },
      { itemCode: "AAA001", itemName: "廚師夏季上衣-M", size: "M", institutionCodeOrName: "8C清福", quantity: 1 },
      { itemCode: "ZZZ111", itemName: "照服夏季上衣-M", size: "M", institutionCodeOrName: "8C清福", quantity: 1 },
      { itemCode: "AAA002", itemName: "廚師夏季上衣-L", size: "L", institutionCodeOrName: "8C清福", quantity: 1 },
      { itemCode: "BBB555", itemName: "廚師夏季圍裙-F", size: "F", institutionCodeOrName: "8C清福", quantity: 1 },
    ];
    const data = buildPivotTableData(lines);
    // 依指定大類別：照服夏季（類別 0）排在 廚師夏季（類別 9）之前，且同類別中 M 先於 L
    expect(data.rows.map((r) => r.itemName)).toEqual([
      "照服夏季上衣-M",
      "照服夏季上衣-L",
      "廚師夏季上衣-M",
      "廚師夏季上衣-L",
      "廚師夏季圍裙-F",
    ]);
  });

  it("strictly sorts 14 item categories in the requested user sequence including 護士冬夏", () => {
    // 建立 14 個指定類別的品項各一個（隨機打亂順序輸入）
    const shuffledCategories = [
      "工務冬季上衣-M",
      "廚師夏季上衣-M",
      "護士冬夏長褲-M",
      "照服冬季上衣-M",
      "幼兒園夏季上衣-M",
      "行政夏季上衣-M",
      "照服夏季上衣-M",
      "護士冬季上衣-M",
      "工務夏季上衣-M",
      "照服初階夏上衣-M",
      "照服行政冬夏褲-M",
      "護士夏季上衣-M",
      "行政冬季上衣-M",
      "照服中高階夏上衣-M",
    ];

    const lines: RawIssueLineInput[] = shuffledCategories.map((itemName, idx) => ({
      itemCode: `ITEM_${idx}`,
      itemName,
      size: "M",
      institutionCodeOrName: "8C清福",
      quantity: 1,
    }));

    const data = buildPivotTableData(lines);
    expect(data.rows.map((r) => r.itemName)).toEqual([
      "照服夏季上衣-M",
      "照服冬季上衣-M",
      "照服行政冬夏褲-M",
      "照服中高階夏上衣-M",
      "照服初階夏上衣-M",
      "護士夏季上衣-M",
      "護士冬季上衣-M",
      "護士冬夏長褲-M",
      "行政夏季上衣-M",
      "行政冬季上衣-M",
      "廚師夏季上衣-M",
      "工務夏季上衣-M",
      "工務冬季上衣-M",
      "幼兒園夏季上衣-M",
    ]);
  });

  it("assigns correct size ranks for S, M, L, XL, 2L, 3L, 4L, 5L, 6L", () => {
    expect(getSizeRank("XS")).toBeLessThan(getSizeRank("S"));
    expect(getSizeRank("S")).toBeLessThan(getSizeRank("M"));
    expect(getSizeRank("M")).toBeLessThan(getSizeRank("L"));
    expect(getSizeRank("L")).toBeLessThan(getSizeRank("XL"));
    expect(getSizeRank("XL")).toBeLessThan(getSizeRank("2L"));
    expect(getSizeRank("2L")).toBeLessThan(getSizeRank("3L"));
    expect(getSizeRank("3L")).toBeLessThan(getSizeRank("4L"));
    expect(getSizeRank("4L")).toBeLessThan(getSizeRank("5L"));
    expect(getSizeRank("5L")).toBeLessThan(getSizeRank("6L"));
  });

  it("sorts mixed sizes (2L, 3L, 5L, L, M, S, XL) into (S, M, L, XL, 2L, 3L, 5L)", () => {
    const inputSizes = ["2L", "3L", "5L", "L", "M", "S", "XL"];
    const lines: RawIssueLineInput[] = inputSizes.map((size, idx) => ({
      itemCode: `ITEM_${idx}`,
      itemName: `工務冬季上衣-${size}`,
      size,
      institutionCodeOrName: "8C清福",
      quantity: 1,
    }));

    const data = buildPivotTableData(lines);
    expect(data.rows.map((r) => r.size)).toEqual([
      "S", "M", "L", "XL", "2L", "3L", "5L"
    ]);
    expect(data.rows.map((r) => r.itemName)).toEqual([
      "工務冬季上衣-S",
      "工務冬季上衣-M",
      "工務冬季上衣-L",
      "工務冬季上衣-XL",
      "工務冬季上衣-2L",
      "工務冬季上衣-3L",
      "工務冬季上衣-5L",
    ]);
  });

  it("strictly captures only the 22 specified institutions and ignores all other units", () => {
    // 包含合法 22 個機構與非法其他機構（例如「總部」、「管理處」、「廠商A」）
    const lines: RawIssueLineInput[] = [
      { itemCode: "ITEM_1", itemName: "照服夏季上衣-M", size: "M", institutionCodeOrName: "8C清福", quantity: 5 },
      { itemCode: "ITEM_1", itemName: "照服夏季上衣-M", size: "M", institutionCodeOrName: "總部管理處", quantity: 10 },
      { itemCode: "ITEM_1", itemName: "照服夏季上衣-M", size: "M", institutionCodeOrName: "外包廠商", quantity: 20 },
      { itemCode: "ITEM_1", itemName: "照服夏季上衣-M", size: "M", institutionCodeOrName: "B2幼兒園", quantity: 3 },
      { itemCode: "ITEM_1", itemName: "照服夏季上衣-M", size: "M", institutionCodeOrName: "其他無關部門", quantity: 50 },
    ];

    const data = buildPivotTableData(lines);

    // 1. 機構欄位數嚴格固定為 22，不產生任何其他分店欄位
    expect(data.institutions.length).toBe(22);
    expect(data.institutions.map((i) => i.shortName)).toEqual([
      "福", "氣", "心", "平", "安",
      "春", "日", "照", "風", "景",
      "山", "泉", "水", "清", "涼",
      "護家", "含笑", "法人", "一館", "二館", "三館", "幼"
    ]);

    // 2. 只有「福」(5) 和「幼」(3) 被抓取，其他（10 + 20 + 50）全部被過濾忽略
    expect(data.rows.length).toBe(1);
    const row = data.rows[0];
    expect(row.quantitiesByInstitution["福"]).toBe(5);
    expect(row.quantitiesByInstitution["幼"]).toBe(3);
    // 總領用數只計算 5 + 3 = 8
    expect(row.totalIssued).toBe(8);
    expect(data.grandTotal).toBe(8);
  });
});

