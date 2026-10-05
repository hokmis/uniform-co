import { describe, expect, it } from "vitest";
import { isPostedInventoryRecord } from "./inventory-post-result";

describe("inventory mutation result", () => {
  it("confirms success only when the server returns an identified POSTED record", () => {
    expect(isPostedInventoryRecord({ id: "operation-1", status: "POSTED" })).toBe(true);
    expect(isPostedInventoryRecord({ id: "operation-1", status: "DRAFT" })).toBe(false);
    expect(isPostedInventoryRecord({ id: "operation-1" })).toBe(false);
    expect(isPostedInventoryRecord(null)).toBe(false);
    expect(isPostedInventoryRecord({ id: "operation-2", status: "POSTED" }, "operation-1")).toBe(false);
  });
});
