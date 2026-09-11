import { describe, expect, it } from "vitest";
import { masterRowsToCsv, parseMasterDataCsv, parseMasterDataJson } from "./master-data";

describe("master data file safety", () => {
  it("parses quoted CSV while preserving leading zeroes", () => {
    const result = parseMasterDataCsv("code,name\n001,\"制服,夏\"\n");
    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([{ code: "001", name: "制服,夏" }]);
  });

  it("rejects formula cells, malformed columns, and NUL bytes", () => {
    expect(parseMasterDataCsv("code,name\n=1+1,ok\n").errors[0].message).toContain("公式");
    expect(parseMasterDataCsv("code,name\n001\n").errors[0].message).toContain("欄位數");
    expect(parseMasterDataCsv("code\n\0").errors[0].message).toContain("NUL");
  });

  it("neutralizes formula prefixes in general CSV exports", () => {
    const csv = masterRowsToCsv([{ code: "=HYPERLINK(\"x\")", name: "ok" }]);
    expect(csv).toContain("'=HYPERLINK");
  });

  it("normalizes JSON rows into string fields", () => {
    expect(parseMasterDataJson('[{"code":"001","active":true}]').rows).toEqual([{ code: "001", active: "true" }]);
  });

  it("rejects oversized JSON before normalizing rows", () => {
    const result = parseMasterDataJson(`[${JSON.stringify({ code: "x".repeat(10_000_001) })}]`);
    expect(result.errors[0].message).toContain("bytes");
  });
});
