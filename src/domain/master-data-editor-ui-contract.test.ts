import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("master data editor loading seams", () => {
  it("separates option reads from mutation busy state", () => {
    const files = [
      "ProductMasterEditorPanel.tsx",
      "OrganizationMasterEditorPanel.tsx",
      "EmployeeMasterEditorPanel.tsx",
    ] as const;

    for (const fileName of files) {
      const source = readFileSync(resolve(process.cwd(), "src/app", fileName), "utf8");
      expect(source, fileName).toContain("const [dataLoading, setDataLoading] = useState(false);");
      expect(source, fileName).toContain("setDataLoading(true)");
      expect(source, fileName).toContain("aria-busy={dataLoading}");
    }
  });

  it("does not use data loading to lock unrelated text fields", () => {
    const productSource = readFileSync(resolve(process.cwd(), "src/app/ProductMasterEditorPanel.tsx"), "utf8");
    const employeeSource = readFileSync(resolve(process.cwd(), "src/app/EmployeeMasterEditorPanel.tsx"), "utf8");
    expect(productSource).toContain('disabled={busy || confirmationOnly}');
    expect(productSource).toContain("const [sourceSnapshotReady, setSourceSnapshotReady] = useState(false);");
    expect(productSource).toContain("createReadRequestController");
    expect(productSource).toContain("const readSequence = readController.begin();");
    expect(productSource).toContain("!readController.isCurrent(readSequence)");
    expect(productSource).toContain("disabled={busy}>{dataLoading ? \"重新整理中…\"");
    expect(productSource).not.toContain("setReloadToken((value) => value + 1); }} disabled={busy || dataLoading}");
    expect(productSource).toContain("disabled={busy || (dataLoading && !sourceSnapshotReady)}");
    expect(productSource).toContain('if (entityType === "SUPPLIER_ITEMS" && !sourceSnapshotReady)');
    expect(productSource).toContain('disabled={busy || (entityType === "SUPPLIER_ITEMS" && !sourceSnapshotReady)}');
    expect(productSource).not.toContain('disabled={busy || (entityType === "SUPPLIER_ITEMS" && dataLoading)}');
    expect(employeeSource).toContain('disabled={fieldDisabled} maxLength={255}');
    expect(employeeSource).not.toContain('const fieldDisabled = busy || confirmationOnly || dataLoading;');
    expect(employeeSource).toContain('disabled={busy || (dataLoading && !form.institutionCode)}');
    expect(employeeSource).toContain('disabled={fieldDisabled || (dataLoading && !form.institutionCode)}');
    expect(employeeSource).not.toContain('disabled={fieldDisabled || dataLoading}');

    const organizationSource = readFileSync(resolve(process.cwd(), "src/app", "OrganizationMasterEditorPanel.tsx"), "utf8");
    expect(organizationSource).toContain("const [institutionSnapshotReady, setInstitutionSnapshotReady] = useState(false);");
    expect(organizationSource).toContain('disabled={busy || (entityType === "DEPARTMENTS" && !institutionSnapshotReady)}');
    expect(organizationSource).toContain('dataLoading && !institutionSnapshotReady');
  });
});
