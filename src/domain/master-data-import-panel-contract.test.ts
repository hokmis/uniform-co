import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "src/app/MasterDataPanel.tsx"), "utf8");

describe("master-data import panel contract", () => {
  it("reuses a fingerprinted attempt across retries of the same file and payload", () => {
    expect(source).toContain("prepareMasterImportAttempt(");
    expect(source).toContain("importAttemptRef.current = attempt;");
    expect(source).toContain("p_idempotency_key: `master-${attempt.idempotencyKey}`");
    expect(source).toContain("p_request_fingerprint: attempt.requestFingerprint");
    expect(source).not.toContain("p_idempotency_key: `master-${crypto.randomUUID()}`");
    expect(source).toContain("系統會沿用同一冪等鍵");
  });

  it("invalidates master-data caches only after the database confirms APPLIED", () => {
    const appliedStart = source.indexOf('if (outcome.kind === "applied")');
    const rejectedStart = source.indexOf('} else if (outcome.kind === "rejected")', appliedStart);
    expect(appliedStart).toBeGreaterThanOrEqual(0);
    expect(rejectedStart).toBeGreaterThan(appliedStart);
    expect(source.slice(appliedStart, rejectedStart)).toContain("invalidateMasterDataCache");
    expect(source.slice(rejectedStart, source.indexOf("} else {", rejectedStart))).not.toContain("invalidateMasterDataCache");
    expect(source).toContain("整批未套用：伺服器檢核");
  });

  it("styles import, export, and validation messages from an explicit notice kind", () => {
    expect(source).toContain('type NoticeKind = "info" | "success" | "error";');
    expect(source).toContain('notice.kind === "success" ? "success-note" : "auth-message"');
    expect(source).not.toContain('identityError ? "auth-message" : "success-note"');
  });

  it("releases the busy state after thrown requests and allows selecting the same file again", () => {
    expect(source).toContain("} finally {\n      setBusy(false);");
    expect(source).toContain("input.value = \"\";");
    expect(source).toContain("disabled={busy} />");
    expect(source).toContain("const existingAttempt = exportAttemptRef.current;");
    expect(source).toContain("p_idempotency_key: `master-export-${attempt.key}`");
    expect(source).toContain("重試會沿用相同冪等鍵，避免重複建立匯出批次");
  });
});
