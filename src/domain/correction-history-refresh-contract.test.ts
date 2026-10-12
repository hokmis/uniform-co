import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const panel = (name: string) => readFileSync(resolve(process.cwd(), "src", "app", name), "utf8");

describe("correction history refresh contract", () => {
  it.each([
    "HrIssueCorrectionPanel.tsx",
    "ReturnCorrectionPanel.tsx",
    "PurchaseReceiptCorrectionPanel.tsx",
    "WarehouseTransferCorrectionPanel.tsx",
    "StocktakeCorrectionPanel.tsx",
  ])("reloads the selected source history when a posted inventory event occurs in %s", (name) => {
    const source = panel(name);

    expect(source).toContain("useInventoryDataRevision(panelActive)");
    expect(source).toMatch(/loadCorrectionHistory[\s\S]*?inventoryRevision/);
  });
});
