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
      title: "平日制服領用統計表",
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
    expect(sheetContent).toContain("平日制服領用統計表");
    expect(sheetContent).toContain("2026-01-21 ～ 2026-02-20");
    expect(sheetContent).toContain("UNT0102");
    expect(sheetContent).toContain("精緻夏季");
    expect(sheetContent).toContain("SUM(");
  });
});
