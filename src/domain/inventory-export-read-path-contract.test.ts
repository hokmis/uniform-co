import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(process.cwd(), "src/app/InventoryHistoryExportPanel.tsx"), "utf8");

describe("inventory export read path", () => {
  it("uses the reporting catalog field allowlist instead of exporting every view column", () => {
    expect(source).toContain("getReportDefinition(reportName)");
    expect(source).toContain("select(report.columns.join(\",\"))");
    expect(source).not.toContain('select("*")');
  });
});
