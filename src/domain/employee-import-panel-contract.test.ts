import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "src/app/EmployeeImportPanel.tsx"), "utf8");

describe("employee import panel contract", () => {
  it("keeps one idempotent operation across unknown results and always releases its busy state", () => {
    expect(source).toContain("const operation = operationRef.current ?? { key: crypto.randomUUID(), fingerprint: \"\" };");
    expect(source).toContain("operationRef.current = operation;");
    expect(source).toContain("`EMP-IMPORT-${operation.key}`");
    expect(source).toContain("匯入結果未知或失敗；再次確認會沿用相同冪等鍵。");
    expect(source).toContain("finally {\n      setBusy(false);");
    expect(source).toContain("input.value = \"\";");
    expect(source).toContain("disabled={busy}");
  });
});
