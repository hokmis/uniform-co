import { describe, expect, it } from "vitest";
import { validateReceiptCorrectionInput } from "./receipt-correction";

const valid = {
  deliveredQuantityDelta: -1,
  acceptedQuantityDelta: -1,
  rejectedQuantityDelta: 0,
  rejectionReason: "",
  reason: "盤點後更正",
};

describe("receipt correction validation", () => {
  it("accepts a non-zero integer correction with a reason", () => {
    expect(validateReceiptCorrectionInput(valid)).toBeNull();
  });

  it("requires a changed quantity and reason", () => {
    expect(validateReceiptCorrectionInput({ ...valid, deliveredQuantityDelta: 0, acceptedQuantityDelta: 0 })).toMatch(/至少/);
    expect(validateReceiptCorrectionInput({ ...valid, reason: " " })).toMatch(/原因/);
  });

  it("requires a rejection reason only when rejected quantity increases", () => {
    expect(validateReceiptCorrectionInput({ ...valid, rejectedQuantityDelta: 1, acceptedQuantityDelta: -1 })).toMatch(/拒收理由/);
    expect(validateReceiptCorrectionInput({ ...valid, rejectedQuantityDelta: -1, acceptedQuantityDelta: 0 })).toBeNull();
  });

  it("rejects fractional or unsafe integer deltas", () => {
    expect(validateReceiptCorrectionInput({ ...valid, acceptedQuantityDelta: 1.5 })).toMatch(/整數/);
    expect(validateReceiptCorrectionInput({ ...valid, acceptedQuantityDelta: Number.MAX_SAFE_INTEGER + 1 })).toMatch(/整數/);
  });
});
