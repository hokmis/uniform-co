import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const panels = [
  "ProductCatalogPanel.tsx",
  "OrganizationCatalogPanel.tsx",
  "EmployeeCatalogPanel.tsx",
  "InventoryAvailabilityPanel.tsx",
];

describe("catalog read refresh UI contract", () => {
  it("uses the shared stale-snapshot policy in every primary catalog", () => {
    const snapshotSource = readFileSync(resolve(process.cwd(), "src/domain/account-scoped-read.ts"), "utf8");
    for (const panel of panels) {
      const source = readFileSync(resolve(process.cwd(), "src/app", panel), "utf8");
      expect(source, panel).toContain("useAccountScopedReadSnapshot");
      expect(source, panel).toContain("useWorkspaceSession");
      expect(source, panel).toContain("identityReady");
      expect(source, panel).toContain("enabled: identityReady");
    }
    expect(snapshotSource).toContain("shouldPreserveReadSnapshot");
    expect(snapshotSource).toContain("staleReadSnapshotMessage");
  });

  it("separates catalog reads from export or mutation busy state", () => {
    const employeeSource = readFileSync(resolve(process.cwd(), "src/app", "EmployeeCatalogPanel.tsx"), "utf8");
    expect(employeeSource).toContain("const [busy, setBusy] = useState(false);");
    expect(employeeSource).toContain("loading: dataLoading");
    expect(employeeSource).toContain("hasCurrentSnapshot: hasCurrentDataSnapshot");
    expect(employeeSource).toContain("loading={dataLoading && visibleRows.length === 0}");
    expect(employeeSource).toContain("disabled={busy || !hasCurrentDataSnapshot || (dataLoading && visibleRows.length === 0)}");
    expect(employeeSource).not.toContain("if (dataLoading) return;");

    const inventorySource = readFileSync(resolve(process.cwd(), "src/app", "InventoryAvailabilityPanel.tsx"), "utf8");
    expect(inventorySource).toContain("loading: dataLoading");
    expect(inventorySource).toContain("aria-busy={dataLoading}");
    expect(inventorySource).toContain("loading={dataLoading && visibleRows.length === 0}");
    expect(inventorySource).not.toContain("const [busy, setBusy] = useState(false);");
  });

  it("separates document and ERP option/status reads from mutations", () => {
    const pdfSource = readFileSync(resolve(process.cwd(), "src/app", "PdfArtifactPanel.tsx"), "utf8");
    const erpSource = readFileSync(resolve(process.cwd(), "src/app", "ErpExportPanel.tsx"), "utf8");
    expect(pdfSource).toContain("const [documentLoading, setDocumentLoading] = useState(false);");
    expect(pdfSource).toContain("const [artifactLoading, setArtifactLoading] = useState(false);");
    expect(pdfSource).toContain("aria-busy={busy || documentLoading || artifactLoading}");
    expect(pdfSource).toContain("disabled={busy || !identityReady || !isArtifactTerminalStatus(artifact.status)}");
    expect(pdfSource).not.toContain("disabled={busy || artifactLoading");
    expect(pdfSource).toContain("setDocumentLoading(true)");
    expect(pdfSource).toContain("setArtifactLoading(true)");
    expect(pdfSource).toContain("disabled={busy || documentLoading || Boolean(artifact)}");
    expect(pdfSource).not.toContain("const [dataLoading, setDataLoading] = useState(false);");
    expect(erpSource).toContain("loading: institutionLoading");
    expect(erpSource).toContain("const [artifactLoading, setArtifactLoading] = useState(false);");
    expect(erpSource).toContain("aria-busy={busy || institutionLoading || artifactLoading}");
    expect(erpSource).toContain("disabled={busy || !identityReady || (artifact !== null && !isArtifactTerminalStatus(artifact.status))}");
    expect(erpSource).not.toContain("disabled={busy || artifactLoading");
    expect(erpSource).toContain('disabled: busy || !identityReady, label: "同批次重試"');
    expect(erpSource).toContain("loadActiveInstitutionOptions(client)");
    expect(erpSource).toContain("setArtifactLoading(true)");
    expect(erpSource).not.toContain("const [dataLoading, setDataLoading] = useState(false);");
  });

  it("keeps ERP creation usable during a same-account institution refresh", () => {
    const erpSource = readFileSync(resolve(process.cwd(), "src/app/ErpExportPanel.tsx"), "utf8");
    expect(erpSource).toContain("useAccountScopedReadSnapshot");
    expect(erpSource).toContain("hasCurrentSnapshot: hasCurrentInstitutionSnapshot");
    expect(erpSource).toContain("enabled: identityReady");
    expect(erpSource).toContain("institutionSelection?.accountId === accountId");
    expect(erpSource).toContain("const institutionSelectionReady = hasCurrentInstitutionSnapshot");
    expect(erpSource).toContain("disabled: busy || !identityReady || !institutionSelectionReady");
    expect(erpSource).not.toContain("disabled: busy || institutionLoading");
    expect(erpSource).not.toContain("disabled={busy || institutionLoading || Boolean(batch)}");
    expect(erpSource).toContain("disabled={busy || !identityReady || !hasCurrentInstitutionSnapshot || Boolean(batch)}");
    expect(erpSource).toContain("if (!identityReady || !client || !hasCurrentInstitutionSnapshot || !institutionSelectionReady || !distributionDate || batch) return;");
  });

  it("does not use mutation busy state for product or organization catalog reads", () => {
    for (const panel of ["ProductCatalogPanel.tsx", "OrganizationCatalogPanel.tsx"]) {
      const source = readFileSync(resolve(process.cwd(), "src/app", panel), "utf8");
      expect(source, panel).toContain("useAccountScopedReadSnapshot");
      expect(source, panel).toContain("loading: dataLoading");
      expect(source, panel).toContain("aria-busy={dataLoading}");
      expect(source, panel).toContain("loading={dataLoading && visibleRows.length === 0}");
      expect(source, panel).not.toContain("const [busy, setBusy] = useState(false);");
    }
  });

  it("uses one request-order seam for overlapping catalog and report reads", () => {
    for (const panel of panels) {
      const source = readFileSync(resolve(process.cwd(), "src/app", panel), "utf8");
      expect(source, panel).toContain("useAccountScopedReadSnapshot");
    }
    const sharedReadSource = readFileSync(resolve(process.cwd(), "src/app/use-account-scoped-read-snapshot.ts"), "utf8");
    expect(sharedReadSource).toContain("createReadRequestController");
    expect(sharedReadSource).toContain("controller.begin()");
    expect(sharedReadSource).toContain("controller.isCurrent(requestSequence)");
    expect(sharedReadSource).toContain("controller.invalidate()");

    const reportingSource = readFileSync(resolve(process.cwd(), "src/app/ReportingPanel.tsx"), "utf8");
    expect(reportingSource).toContain("createReadRequestController");
    expect(reportingSource).toContain("const readSequence = readController.begin();");
    expect(reportingSource).toContain("!readController.isCurrent(readSequence)");
    expect(reportingSource).toContain("if (active && readController.isCurrent(readSequence)) setDataLoading(false)");
  });

  it("keeps read-only refresh controls available while the latest read owns loading", () => {
    const refreshFragments = [
      ["ProductCatalogPanel.tsx", "setReloadToken((value) => value + 1); }} disabled={dataLoading}"],
      ["OrganizationCatalogPanel.tsx", "setReloadToken((value) => value + 1); }} disabled={dataLoading}"],
      ["EmployeeCatalogPanel.tsx", "setReloadToken((value) => value + 1); }} disabled={busy || dataLoading}"],
      ["InventoryAvailabilityPanel.tsx", "onClick={() => setReloadToken((value) => value + 1)} disabled={dataLoading}"],
      ["ReportingPanel.tsx", "onClick={() => setReloadToken((value) => value + 1)} disabled={dataLoading}"],
      ["ProcurementReasonCodePanel.tsx", "setReloadToken((value) => value + 1)} disabled={busy || dataLoading}"],
    ] as const;
    for (const [panel, fragment] of refreshFragments) {
      const panelSource = readFileSync(resolve(process.cwd(), "src/app", panel), "utf8");
      expect(panelSource, panel).not.toContain(fragment);
    }
    const hrSource = readFileSync(resolve(process.cwd(), "src/app", "HrRequestWorkbench.tsx"), "utf8");
    expect(hrSource).not.toContain("onClick={reloadOperationalData} disabled={loadingData || submitting}");
    expect(hrSource).toContain("onClick={reloadOperationalData} disabled={submitting}");
  });

  it("uses account-bound read snapshots for correction sources", () => {
    for (const panel of [
      "HrIssueCorrectionPanel.tsx",
      "ReturnCorrectionPanel.tsx",
      "PurchaseReceiptCorrectionPanel.tsx",
      "WarehouseTransferCorrectionPanel.tsx",
      "StocktakeCorrectionPanel.tsx",
    ]) {
      const source = readFileSync(resolve(process.cwd(), "src/app", panel), "utf8");
      expect(source, panel).toContain("useAccountScopedReadSnapshot");
      expect(source, panel).toContain("hasCurrentSnapshot: sourceSnapshotReady");
      expect(source, panel).toContain("enabled: identityReady");
      expect(source, panel).toContain("const sourceReadBlocked = dataLoading && !sourceSnapshotReady;");
      expect(source, panel).toContain("aria-busy={busy || dataLoading}");
      expect(source, panel).toContain("disabled: busy || sourceReadBlocked");
      expect(source, panel).not.toContain("shouldPreserveReadSnapshot");
      expect(source, panel).not.toContain("const [sourceSnapshotReady, setSourceSnapshotReady]");
      expect(source, panel).toContain("role=\"status\" aria-live=\"polite\"");
    }
  });

  it("binds stocktake correction sources to the account's warehouse-role scope", () => {
    const stocktakeSource = readFileSync(resolve(process.cwd(), "src/app", "StocktakeCorrectionPanel.tsx"), "utf8");
    expect(stocktakeSource).toContain("const sourceScopeId = accountId ? `${accountId}:");
    expect(stocktakeSource).toContain("accountId: sourceScopeId");
    expect(stocktakeSource).toContain("canCountHr");
    expect(stocktakeSource).toContain("canCountGeneral");
  });
});
