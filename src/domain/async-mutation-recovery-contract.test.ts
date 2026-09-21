import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("async mutation recovery contract", () => {
  it("keeps organization saves idempotent and accepts only an APPLIED RPC result", () => {
    const panel = source("src/app/OrganizationMasterEditorPanel.tsx");
    expect(panel).toContain("prepareOperationAttempt(");
    expect(panel).toContain("operationRef.current = operation;");
    expect(panel).toContain("`ORGANIZATION-MASTER-${operation.key}`");
    expect(panel).toContain('result?.status !== "APPLIED"');
    expect(panel).toContain("} finally {\n      setBusy(false);");
    expect(panel).toContain("同一冪等鍵");
  });

  it("always releases employee-editor busy state while retaining an unresolved attempt", () => {
    const panel = source("src/app/EmployeeMasterEditorPanel.tsx");
    expect(panel).toContain("prepareOperationAttempt(");
    expect(panel).toContain("operationRef.current = operation;");
    expect(panel).toContain("`EMPLOYEE-MASTER-${operation.key}`");
    expect(panel).toContain("finally {");
    expect(panel).toContain("setBusy(false);");
    expect(panel).toContain("同一冪等鍵");
  });

  it("reports inventory export failures as errors and releases busy state after network exceptions", () => {
    const panel = source("src/app/InventoryHistoryExportPanel.tsx");
    expect(panel).toContain('type MessageKind = "info" | "success" | "error";');
    expect(panel).toContain("catch {");
    expect(panel).toContain("finally {");
    expect(panel).toContain('messageKind === "success" ? "success-note" : "auth-message"');
    expect(panel).toContain("同一個匯出作業");
  });
});
