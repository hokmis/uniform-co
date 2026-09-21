import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sources = [
  "src/app/ProductMasterEditorPanel.tsx",
  "src/app/OrganizationMasterEditorPanel.tsx",
  "src/app/MasterDataPanel.tsx",
  "src/app/ProductCatalogPanel.tsx",
].map((file) => readFileSync(join(process.cwd(), file), "utf8"));

describe("master data UI error boundary", () => {
  it("does not surface raw database or storage error text", () => {
    for (const source of sources) {
      expect(source).not.toContain("原始訊息");
      expect(source).not.toContain("error.details");
      expect(source).not.toContain("error.hint");
      expect(source).not.toContain("result.error_message ??");
    }
  });
});
