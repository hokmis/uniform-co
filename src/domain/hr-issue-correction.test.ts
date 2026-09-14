import { describe, expect, it } from "vitest";
import { validateHrIssueCorrectionInput } from "./hr-issue-correction";

describe("validateHrIssueCorrectionInput", () => {
  it("requires a non-zero safe integer", () => {
    expect(validateHrIssueCorrectionInput({ issueQuantityDelta: 0, reason: "補登" })).toContain("非零");
    expect(validateHrIssueCorrectionInput({ issueQuantityDelta: 1.5, reason: "補登" })).toContain("整數");
  });

  it("requires a bounded reason", () => {
    expect(validateHrIssueCorrectionInput({ issueQuantityDelta: 1, reason: " " })).toContain("原因");
    expect(validateHrIssueCorrectionInput({ issueQuantityDelta: 1, reason: "x".repeat(501) })).toContain("500");
  });

  it("accepts a signed delta with a reason", () => {
    expect(validateHrIssueCorrectionInput({ issueQuantityDelta: -2, reason: "沖回重複發放" })).toBeNull();
  });
});
