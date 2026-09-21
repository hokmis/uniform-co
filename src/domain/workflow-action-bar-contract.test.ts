import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const component = readFileSync(resolve(process.cwd(), "src", "app", "WorkflowActionBar.tsx"), "utf8");
const panels = [
  "HrIssueCorrectionPanel.tsx",
  "PurchaseReceiptCorrectionPanel.tsx",
  "ReturnCorrectionPanel.tsx",
  "StocktakeCorrectionPanel.tsx",
  "WarehouseTransferCorrectionPanel.tsx",
  "PurchaseReceiptPanel.tsx",
  "ReturnPanel.tsx",
  "StocktakePanel.tsx",
  "WarehouseShipmentPanel.tsx",
  "PdfArtifactPanel.tsx",
  "ErpExportPanel.tsx",
  "HrRequestWorkbench.tsx",
].map((fileName) => readFileSync(resolve(process.cwd(), "src", "app", fileName), "utf8"));

describe("workflow action bar", () => {
  it("keeps one primary action and progressively discloses secondary actions", () => {
    expect(component).toContain("workflow-secondary-actions");
    expect(component).toContain("primary-button");
    expect(component).toContain("其他操作");
  });

  it("is shared by transaction and correction panels", () => {
    for (const source of panels) expect(source).toContain("WorkflowActionBar");
  });
});
