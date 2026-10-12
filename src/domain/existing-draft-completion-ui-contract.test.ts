import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readPanel = (fileName: string) => readFileSync(resolve(process.cwd(), "src/app", fileName), "utf8");

describe("single-action completion of editable drafts", () => {
  it("lets the receipt confirmation apply current form values without a separate save-draft action", () => {
    const source = readPanel("PurchaseReceiptPanel.tsx");

    expect(source).toContain("existingReceipt: receipt ?? undefined");
    expect(source).toContain("updateIdempotencyKey:");
    expect(source).not.toContain("先保存入庫草稿");
    expect(source).not.toContain("保存草稿修改");
  });

  it("lets the return confirmation apply current editable values without a separate save-draft action", () => {
    const source = readPanel("ReturnPanel.tsx");

    expect(source).toContain("existingReturnNote: activeReturnNote ?? undefined");
    expect(source).toContain("updateIdempotencyKey:");
    expect(source).not.toContain("先保存退回草稿");
    expect(source).not.toContain("保存退回草稿");
  });
});
