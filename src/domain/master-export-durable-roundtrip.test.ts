import { describe, expect, it } from "vitest";
import { masterRowsToCsv } from "./master-data";
import { parseBoundedCsv } from "./import-worker-parser";
import { buildImportPreviewRows } from "./import-worker";

describe("master export to durable import", () => {
  it("keeps unchanged exported uniform items as SKIP, including quoted names and leading zeroes", () => {
    const rows = [
      { code: "001-XS", name: '上衣, "長袖"', size: "XS", unit: "件", season: "全年", category: "上衣", isActive: true },
      { code: "002-M", name: "停用長褲", size: "M", unit: "件", season: "全年", category: "下身", isActive: false },
    ];
    const csv = masterRowsToCsv(rows);
    const parsed = parseBoundedCsv(new TextEncoder().encode(csv));
    const preview = buildImportPreviewRows("UNIFORM_ITEMS", parsed.sheets[0].rows,
      rows.map((row) => ({ ...row, kind: "UNIFORM_ITEM" })));
    expect(preview.map((row) => row.proposed_action)).toEqual(["SKIP", "SKIP"]);
    expect(preview.map((row) => row.validation_errors)).toEqual([[], []]);
    expect(preview.map((row) => row.diffs)).toEqual([[], []]);
    expect(preview[0].normalized_values?.code).toBe("001-XS");
    expect(preview[0].normalized_values?.name).toBe('上衣, "長袖"');
    expect(preview[1].normalized_values?.isActive).toBe("false");
  });
});
