import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { ImportParserError, parseBoundedCsv, parseBoundedXlsx, parseBoundedImportFile } from "./import-worker-parser";

const bytes = (value: string) => new TextEncoder().encode(value);

describe("bounded import worker parser", () => {
  it("rejects malformed CSV, formulas, NUL and column drift", () => {
    expect(() => parseBoundedCsv(bytes('employee_no,name\n001,"unterminated'))).toThrowError(ImportParserError);
    expect(() => parseBoundedCsv(bytes("employee_no,name\n=1+1,Alice"))).toThrowError(/公式/);
    expect(() => parseBoundedCsv(bytes("employee_no,name\n001,Alice\0"))).toThrowError(/NUL/);
    expect(() => parseBoundedCsv(bytes("employee_no,name\n001"))).toThrowError(/欄位數/);
  });

  it("preserves quoted CSV fields and leading zeroes", () => {
    const result = parseBoundedCsv(bytes('employee_no,name\n001,"陳,小明"\n'));
    expect(result.sheets[0].rows).toEqual([["employee_no", "name"], ["001", "陳,小明"]]);
  });

  it("rejects ZIP traversal, macro entries, bombs and unsafe XML", () => {
    const make = (entries: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(entries).map(([name, value]) => [name, bytes(value)])));
    const base = { "[Content_Types].xml": "<Types/>", "xl/workbook.xml": "<workbook/>", "xl/worksheets/sheet1.xml": "<worksheet><sheetData><row><c r=\"A1\"><v>id</v></c></row></sheetData></worksheet>" };
    expect(() => parseBoundedXlsx(make({ ...base, "../escape.txt": "x" }))).toThrowError(/路徑/);
    expect(() => parseBoundedXlsx(make({ ...base, "xl/vbaProject.bin": "macro" }))).toThrowError(/巨集/);
    expect(() => parseBoundedXlsx(make({ ...base, "xl/connections.xml": "<connections/>" }))).toThrowError(/連線/);
    expect(() => parseBoundedXlsx(make({ ...base, "xl/_rels/workbook.xml.rels": "<Relationships><Relationship TargetMode=\"External\" Target=\"https://example.test\"/></Relationships>" }))).toThrowError(/外部/);
    expect(() => parseBoundedXlsx(make({ ...base, "xl/worksheets/sheet2.xml": "<worksheet/>" }), { maxSheets: 1 })).toThrowError(/工作表/);
    expect(() => parseBoundedXlsx(make({ ...base, "xl/worksheets/sheet1.xml": "<!DOCTYPE x><worksheet/>" }))).toThrowError(/外部/);
    expect(() => parseBoundedXlsx(make({ ...base, "xl/worksheets/sheet1.xml": "<worksheet><sheetData><row><c r=\"A1\"><x:f>1+1</x:f><v>2</v></c></row></sheetData></worksheet>" }))).toThrowError(/公式/);
    expect(() => parseBoundedXlsx(make({ ...base, "xl/worksheets/sheet1.xml": "<worksheet><sheetData><row><row><row>" }))).toThrowError(/結構/);
    const malformedRows = "<worksheet><sheetData>" + "<row>".repeat(200);
    expect(() => parseBoundedXlsx(make({ ...base, "xl/worksheets/sheet1.xml": malformedRows }), { maxCompressionRatio: 100_000 })).toThrowError(/結構/);
  });

  it("parses a minimal XLSX sheet and enforces filename/MIME pairing", () => {
    const zip = zipSync({
      "[Content_Types].xml": bytes("<Types/>") ,
      "xl/workbook.xml": bytes("<workbook/>") ,
      "xl/worksheets/sheet1.xml": bytes("<worksheet><sheetData><row><c r=\"A1\" t=\"inlineStr\"><is><t>employee_no</t></is></c><c r=\"B1\" t=\"inlineStr\"><is><t>name</t></is></c></row><row><c r=\"A2\" t=\"inlineStr\"><is><t>001</t></is></c><c r=\"B2\" t=\"inlineStr\"><is><t>Alice</t></is></c></row></sheetData></worksheet>"),
    });
    expect(parseBoundedXlsx(zip).sheets[0].rows).toEqual([["employee_no", "name"], ["001", "Alice"]]);
    const numericIdentifierZip = zipSync({
      "[Content_Types].xml": bytes("<Types/>"),
      "xl/workbook.xml": bytes("<workbook/>"),
      "xl/worksheets/sheet1.xml": bytes("<worksheet><sheetData><row><c r=\"A1\" t=\"inlineStr\"><is><t>employee_no</t></is></c></row><row><c r=\"A2\"><v>1E3</v></c></row></sheetData></worksheet>"),
    });
    expect(() => parseBoundedXlsx(numericIdentifierZip)).toThrowError(/識別碼/);
    const twoSheetZip = zipSync({
      "[Content_Types].xml": bytes("<Types/>"),
      "xl/workbook.xml": bytes("<workbook/>"),
      "xl/worksheets/sheet1.xml": bytes("<worksheet><sheetData><row><c r=\"A1\" t=\"inlineStr\"><is><t>id</t></is></c></row></sheetData></worksheet>"),
      "xl/worksheets/sheet2.xml": bytes("<worksheet><sheetData><row><c r=\"A1\" t=\"inlineStr\"><is><t>id</t></is></c></row></sheetData></worksheet>"),
    });
    expect(() => parseBoundedXlsx(twoSheetZip, { maxCells: 1 })).toThrowError(/儲存格總數/);
    expect(parseBoundedImportFile(zip, "employees.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").kind).toBe("XLSX");
    expect(() => parseBoundedImportFile(zip, "employees.xlsx", "text/csv")).toThrowError(/副檔名/);
  });
});
