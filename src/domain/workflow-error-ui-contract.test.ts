import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const files = [
  "src/app/EmployeeCatalogPanel.tsx",
  "src/app/EmployeeMasterEditorPanel.tsx",
  "src/app/EmployeeImportPanel.tsx",
  "src/app/ProcurementReasonCodePanel.tsx",
  "src/app/PurchaseReceiptPanel.tsx",
  "src/app/ReplenishmentPanel.tsx",
  "src/app/ReportingPanel.tsx",
  "src/app/SeasonalProcurementPanel.tsx",
  "src/app/ReturnPanel.tsx",
  "src/app/SeasonalDemandPanel.tsx",
  "src/app/StocktakePanel.tsx",
  "src/app/SeasonalCampaignPanel.tsx",
  "src/app/SeasonalApprovalPanel.tsx",
  "src/app/HrIssueCorrectionPanel.tsx",
  "src/app/PurchaseReceiptCorrectionPanel.tsx",
  "src/app/ReturnCorrectionPanel.tsx",
  "src/app/StocktakeCorrectionPanel.tsx",
  "src/app/WarehouseTransferCorrectionPanel.tsx",
  "src/app/HrRequestWorkbench.tsx",
  "src/app/StocktakePanel.tsx",
].map((file) => readFileSync(join(process.cwd(), file), "utf8"));
const accountAdminSource = readFileSync(join(process.cwd(), "src/app/AccountAdminPanel.tsx"), "utf8");

describe("workflow error UI boundary", () => {
  it("routes server operation failures through the safe error adapter", () => {
    for (const source of files) {
      expect(source).toContain("safeSupabase");
      expect(source).not.toMatch(/setMessage\(`[^`]*\$\{error\.message\}/);
    }
    const employeeImportSource = files[2];
    expect(employeeImportSource).not.toContain("error.error_message ??");
    expect(employeeImportSource).not.toContain("error.error_code ??");
    expect(accountAdminSource).not.toContain("result.error ??");
    expect(accountAdminSource).not.toContain("result.warning ??");
    expect(accountAdminSource).not.toContain("error.message");
    expect(accountAdminSource).toContain("useWorkspaceSession");
    expect(accountAdminSource).not.toContain("auth.getSession()");
  });
});
