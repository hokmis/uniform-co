import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const correctionPanels = [
  ["ReturnCorrectionPanel.tsx", "complete_return_correction", "create_return_correction_draft", "post_return_correction"],
  ["HrIssueCorrectionPanel.tsx", "complete_hr_issue_correction", "create_hr_issue_correction_draft", "post_hr_issue_correction"],
  ["WarehouseTransferCorrectionPanel.tsx", "complete_warehouse_transfer_correction", "create_warehouse_transfer_correction_draft", "post_warehouse_transfer_correction"],
  ["PurchaseReceiptCorrectionPanel.tsx", "complete_purchase_receipt_correction", "create_purchase_receipt_correction_draft", "post_purchase_receipt_correction"],
  ["StocktakeCorrectionPanel.tsx", "complete_stocktake_correction", "create_stocktake_correction_draft", "post_stocktake_correction"],
] as const;

describe("correction completion panels", () => {
  it.each(correctionPanels)("uses the one-call completion seam for %s", (fileName, atomicName, createName, postName) => {
    const source = readFileSync(resolve(process.cwd(), "src", "app", fileName), "utf8");
    expect(source).toContain("completeCorrectionOperation");
    expect(source).toContain("correctionCompletionPlan");
    expect(source).toContain(`atomicFunctionName: "${atomicName}"`);
    expect(source).toContain(`createFunctionName: "${createName}"`);
    expect(source).toContain(`postFunctionName: "${postName}"`);
    expect(source).toContain("correctionPostRequestFingerprint");
    expect(source).toContain(":post-fingerprint");
    expect(source).toContain("getItem(");
    expect(source).toContain("重試同一筆（結果待確認）");
    expect(source).toContain("結果待確認");
    expect(source).toContain("查無尚未完成的");
    expect(source).toContain("先建立");
  });
});
