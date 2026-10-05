import { describe, expect, it } from "vitest";
import { calculateInventoryPreview } from "./inventory-preview";

const input = { hrOnHand: 20, generalOnHand: 100, activeReserved: 0, issueQuantity: 10, increaseQuantity: 0, actualTransfer: 5 };

describe("inventory preview feedback", () => {
  it("preserves a valid request when warehouse confirmation needs a reason", () => {
    const result = calculateInventoryPreview(input, "");
    expect(result.request?.availableToRequest).toBe(120);
    expect(result.requestError).toBe("");
    expect(result.post).toBeNull();
    expect(result.postError).toBe("實際調庫量低於最大可調量，請填寫短發原因。");
  });
  it("shows final balances once the reason is supplied", () => {
    expect(calculateInventoryPreview(input, "現貨不足").post?.hrOnHandAfter).toBe(15);
  });
  it("does not allow over-requesting or negative inventory", () => {
    expect(calculateInventoryPreview({ ...input, issueQuantity: 121 }, "").request).toBeNull();
    expect(calculateInventoryPreview({ ...input, hrOnHand: 0 }, "已核對").post).toBeNull();
  });
  it("does not expose English internal field names for invalid quantities", () => {
    expect(calculateInventoryPreview({ ...input, actualTransfer: -1 }, "").postError).toBe("數量必須是零或正整數，請檢查輸入。");
  });
});
