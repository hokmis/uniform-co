import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("inventory correction retry storage", () => {
  it.each([
    "StocktakeCorrectionPanel.tsx",
    "WarehouseTransferCorrectionPanel.tsx",
    "HrIssueCorrectionPanel.tsx",
    "ReturnCorrectionPanel.tsx",
    "PurchaseReceiptCorrectionPanel.tsx",
  ])(
    "refuses to post unless %s can persist idempotency recovery state",
    (fileName) => {
      const source = readFileSync(resolve(process.cwd(), "src/app", fileName), "utf8");

      expect(source).toContain("readBrowserStorageEntries");
      expect(source).toContain("writeBrowserStorageEntries");
      expect(source).toContain("OPERATION_RECOVERY_STORAGE_UNAVAILABLE_MESSAGE");
      expect(source).toContain("recoveryStorageUnavailable");
      expect(source).not.toContain("window.localStorage.setItem(");
      const atomicCall = source.indexOf("const result = await completeCorrectionOperation");
      const recoveryWrite = source.lastIndexOf("if (!writeBrowserStorageEntries([", atomicCall);
      expect(recoveryWrite).toBeGreaterThan(-1);
      expect(recoveryWrite).toBeLessThan(atomicCall);
      const correctionHandler = source.indexOf("async function completeCorrection()");
      const storageFailureGuard = source.indexOf("if (recoveryStorageUnavailable) return", correctionHandler);
      expect(storageFailureGuard).toBeGreaterThan(correctionHandler);
      expect(storageFailureGuard).toBeLessThan(atomicCall);
      const legacyPostCall = source.indexOf("response = await client.rpc(");
      if (legacyPostCall >= 0) {
        const legacyPostGuard = source.lastIndexOf("if (!stored.available || !writeBrowserStorageEntries", legacyPostCall);
        expect(legacyPostGuard).toBeGreaterThan(-1);
        expect(legacyPostGuard).toBeLessThan(legacyPostCall);
      }
    },
  );

  it.each([
    ["HrIssueCorrectionPanel.tsx", "post_hr_issue_correction"],
    ["ReturnCorrectionPanel.tsx", "post_return_correction"],
    ["PurchaseReceiptCorrectionPanel.tsx", "post_purchase_receipt_correction"],
  ])("guards %s draft completion with durable retry state before the POST RPC", (fileName, postFunction) => {
    const source = readFileSync(resolve(process.cwd(), "src/app", fileName), "utf8");

    expect(source).toContain("readBrowserStorageEntries");
    expect(source).toContain("writeBrowserStorageEntries");
    expect(source).not.toContain("window.localStorage.");
    const rpcCall = source.indexOf(`client.rpc("${postFunction}"`);
    const storageGuard = source.lastIndexOf("if (!stored.available || !writeBrowserStorageEntries", rpcCall);
    expect(rpcCall).toBeGreaterThan(-1);
    expect(storageGuard).toBeGreaterThan(-1);
    expect(storageGuard).toBeLessThan(rpcCall);
  });

  it("explains that storage failure prevented any correction write", () => {
    const source = readFileSync(resolve(process.cwd(), "src/lib/browser-operation-storage.ts"), "utf8");
    expect(source).toContain("未送出更正，也沒有變更庫存");
  });
});
