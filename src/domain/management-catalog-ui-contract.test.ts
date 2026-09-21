import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(process.cwd(), "src", "app", "ManagementCatalogTable.tsx"), "utf8");
const styles = readFileSync(resolve(process.cwd(), "src", "app", "globals.css"), "utf8");

describe("management catalog display settings", () => {
  it("keeps non-daily view controls behind one collapsed disclosure", () => {
    expect(source).toContain('<details className="management-view-settings">');
    expect(source).toContain('<summary className="secondary-button">顯示設定</summary>');
    expect(source).toContain('className="management-catalog-view-actions"');
    expect(styles).toContain(".management-view-settings > .management-catalog-view-actions");
  });

  it("retains page size, density, and column controls inside the disclosure", () => {
    const settingsStart = source.indexOf('<details className="management-view-settings">');
    const settingsEnd = source.indexOf("</details>", settingsStart);
    const settings = source.slice(settingsStart, settingsEnd);
    expect(settings).toContain("pageSizeOptions");
    expect(settings).toContain("management-density-button");
    expect(settings).toContain("management-column-settings");
  });

  it("keeps the first read distinguishable from an empty result", () => {
    expect(source).toContain("loading?: boolean;");
    expect(source).toContain('className="management-catalog-loading"');
    expect(source).toContain('role="status" aria-live="polite"');
    expect(source).toContain('if (loading && rows.length === 0)');
    expect(styles).toContain(".management-catalog-loading");
    expect(styles).toContain("prefers-reduced-motion: reduce");
  });
});
