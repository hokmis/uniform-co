import { describe, expect, it } from "vitest";
import { validateReturnCorrectionInput } from "./return-correction";

describe("return correction validation", () => {
  it("accepts a signed integer delta with a reason", () => {
    expect(validateReturnCorrectionInput({ returnQuantityDelta: -1, reason: "誤登退回" })).toBeNull();
  });

  it("requires a non-zero delta and reason", () => {
    expect(validateReturnCorrectionInput({ returnQuantityDelta: 0, reason: "x" })).toMatch(/不可為 0/);
    expect(validateReturnCorrectionInput({ returnQuantityDelta: 1, reason: " " })).toMatch(/原因/);
  });

  it("rejects fractional and unsafe values", () => {
    expect(validateReturnCorrectionInput({ returnQuantityDelta: 1.5, reason: "x" })).toMatch(/整數/);
    expect(validateReturnCorrectionInput({ returnQuantityDelta: Number.MAX_SAFE_INTEGER + 1, reason: "x" })).toMatch(/整數/);
  });
});
