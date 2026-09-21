import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readPanel(fileName: string): string {
  return readFileSync(resolve(process.cwd(), "src", "app", fileName), "utf8");
}

describe("business read retry boundary", () => {
  it("keeps admin, import, export, and correction recovery reads on the shared session adapter", () => {
    for (const fileName of [
      "AccountAdminPanel.tsx",
      "EmployeeImportPanel.tsx",
      "ErpExportPanel.tsx",
      "ProcurementReasonCodePanel.tsx",
      "HrIssueCorrectionPanel.tsx",
      "StocktakeCorrectionPanel.tsx",
      "WarehouseTransferCorrectionPanel.tsx",
    ]) {
      const source = readPanel(fileName);
      expect(source, fileName).toContain("retrySupabaseQueriesAfterSessionRefresh");
    }
  });

  it("keeps ERP artifact polling on the same retry boundary as its recovery read", () => {
    const source = readPanel("ErpExportPanel.tsx");
    expect(source).toContain('get_erp_artifact_status');
    expect(source).toContain('async () => [await client.rpc("get_erp_artifact_status"');
  });

  it("does not update unmounted reason-code panels after a delayed read", () => {
    const source = readPanel("ProcurementReasonCodePanel.tsx");
    expect(source).toContain("let active = true");
    expect(source).toContain("if (!active || !readController.isCurrent(readSequence)) return");
    expect(source).toContain("return () => { active = false; }");
  });
});
