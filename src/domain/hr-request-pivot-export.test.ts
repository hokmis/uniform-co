import { describe, expect, it } from "vitest";
import {
  ORDERED_INSTITUTION_NAMES,
  resolveInstitutionInfo,
  buildPivotTableData,
  generatePivotXlsx,
  getExcelColumnName,
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

    // 驗證期末量表頭
    expect(sheetContent).toContain("<is><t>I=C+E+G+H</t></is>");
    expect(sheetContent).toContain("<is><t>G=B+F</t></is>");

    // 驗證期末量實際公式包含 C + E + G + H 欄位相加
    // 22 個機構 + 5 個左側欄位 = 第 27 欄 (AA) 為最後一個機構
    // sumCol (B) = AB, balanceCol (C) = AC, damageCol (D) = AD, estimateCol (E) = AE, remark = AF, replenishmentCol (F) = AG, issueCol (G) = AH, returnCol (H) = AI, finalCol (I) = AJ
    expect(sheetContent).toContain("<f>AC5+AE5+AH5+AI5</f>");
    // 驗證期末量計算值 (100 - 5) + (5 + 20) = 120
    expect(sheetContent).toContain("<v>120</v>");
    // 驗證本次發放量公式 G=B+F (AB5+AG5)
    expect(sheetContent).toContain("<f>AB5+AG5</f>");
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

  it("applies light green fill (#E2EFDA) to initial, balance and final quantity columns, wraps E2 header, and sums all quantity columns in total row", () => {
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

    // 1. 樣式驗證：包含 FFE2EFDA
    expect(stylesContent).toContain('rgb="FFE2EFDA"');

    // 2. 表頭 E2 換行文字：期&#10;初&#10;量，並套用樣式 14
    expect(sheetContent).toContain('<c r="E2" t="inlineStr" s="14"><is><t>期&#10;初&#10;量</t></is></c>');

    // 3. 月結量與期末量表頭套用樣式 14
    // 22 分店：E (5), F~AA (6~27), AB (28=sum), AC (29=balance), AD (30), AE (31), AF (32), AG (33), AH (34), AI (35), AJ (36=final)
    expect(sheetContent).toContain('<c r="AC2" t="inlineStr" s="14"><is><t>月結量(抽盤)</t></is></c>');
    expect(sheetContent).toContain('<c r="AJ2" t="inlineStr" s="14"><is><t>期末量(下期期初)</t></is></c>');

    // 4. 資料列套用綠底樣式 17
    expect(sheetContent).toContain('<c r="E5" s="17"><v>50</v></c>');
    expect(sheetContent).toContain('<c r="AC5" s="17">');
    expect(sheetContent).toContain('<c r="AJ5" s="17">');

    // 5. 合計列（Row 7）從期初量至期末量全數計算合計量與 SUM 公式
    expect(sheetContent).toContain('<c r="E7" s="18"><f>SUM(E5:E6)</f><v>80</v></c>');
    expect(sheetContent).toContain('<c r="AB7" s="8"><f>SUM(AB5:AB6)</f><v>5</v></c>');
    expect(sheetContent).toContain('<c r="AC7" s="18"><f>SUM(AC5:AC6)</f><v>75</v></c>'); // 80 - 5 = 75
    expect(sheetContent).toContain('<c r="AD7" s="8"><f>SUM(AD5:AD6)</f></c>');
    expect(sheetContent).toContain('<c r="AE7" s="8"><f>SUM(AE5:AE6)</f></c>');
    expect(sheetContent).toContain('<c r="AG7" s="8"><f>SUM(AG5:AG6)</f><v>5</v></c>');
    expect(sheetContent).toContain('<c r="AH7" s="8"><f>SUM(AH5:AH6)</f><v>10</v></c>'); // 5 + 5
    expect(sheetContent).toContain('<c r="AI7" s="8"><f>SUM(AI5:AI6)</f></c>');
    expect(sheetContent).toContain('<c r="AJ7" s="18"><f>SUM(AJ5:AJ6)</f><v>85</v></c>'); // 80 + 5 = 85
  });
});
