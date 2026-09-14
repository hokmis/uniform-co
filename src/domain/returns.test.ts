import { describe, expect, it } from "vitest";
import { calculateRemainingIssued, ReturnValidationError } from "./returns";

describe("return quantity rules", () => {
  it("calculates the remaining effective issued quantity", () => {
    expect(
      calculateRemainingIssued({ originalIssued: 10, alreadyReturned: 2, returnQuantity: 3 }),
    ).toBe(5);
  });

  it("rejects a return above the remaining issued quantity", () => {
    expect(() =>
      calculateRemainingIssued({ originalIssued: 10, alreadyReturned: 8, returnQuantity: 3 }),
    ).toThrow(ReturnValidationError);
  });
});
