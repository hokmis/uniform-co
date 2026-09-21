import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const retainedQueryPanels = [
  "EmployeeImportPanel.tsx",
  "EmployeeMasterEditorPanel.tsx",
  "OrganizationMasterEditorPanel.tsx",
  "ProductMasterEditorPanel.tsx",
  "ProcurementReasonCodePanel.tsx",
  "PurchaseReceiptCorrectionPanel.tsx",
  "PurchaseReceiptPanel.tsx",
  "ReplenishmentPanel.tsx",
  "ReturnCorrectionPanel.tsx",
  "ReturnPanel.tsx",
  "SeasonalApprovalPanel.tsx",
  "SeasonalCampaignPanel.tsx",
  "SeasonalDemandPanel.tsx",
  "SeasonalProcurementPanel.tsx",
  "StocktakeCorrectionPanel.tsx",
  "StocktakePanel.tsx",
  "WarehouseTransferCorrectionPanel.tsx",
] as const;

describe("retained query panel activity contract", () => {
  it("pauses hidden retained data reads while preserving panel state", () => {
    for (const fileName of retainedQueryPanels) {
      const source = readFileSync(`src/app/${fileName}`, "utf8");
      expect(source, fileName).toContain("usePanelActivity");
      expect(source, fileName).toContain("panelActive");
    }
  });
});
