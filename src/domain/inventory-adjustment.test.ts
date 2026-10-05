import { describe, expect, it } from "vitest";
import { adjustmentSampleCsv, parseAdjustmentCsv, signedAdjustmentQuantity } from "./inventory-adjustment";

describe("signed inventory adjustment", () => {
  it.each(["1", "+12", "-5", " 99 "])("accepts integer delta %s", (value) => expect(signedAdjustmentQuantity(value)).toBe(Number(value)));
  it.each(["0", "-0", "1.2", "1e2", "=1+2", "-1+2", "10000001", "Infinity", ""])("rejects unsafe delta %s", (value) => expect(() => signedAdjustmentQuantity(value)).toThrow());
  it("imports Chinese columns and quoted multiline reasons without applying", () => {
    expect(parseAdjustmentCsv('\uFEFF品號,調整數量,原因\r\nSKU-1,+2,"補庫,\n修正"\r\nSKU-2,-1,破損')).toEqual([
      { item_code: "SKU-1", quantity_delta: 2, reason: "補庫,\n修正" },
      { item_code: "SKU-2", quantity_delta: -1, reason: "破損" },
    ]);
  });
  it.each([
    'item_code,quantity_delta,reason\nA,1,ok\nA,-1,ok',
    'item_code,quantity_delta,reason\nA,1,=HYPERLINK("x")',
    'item_code,quantity_delta,reason\nA,-1+1,ok',
    'item_code,quantity_delta,reason\n"A"garbage,1,ok',
    'item_code,quantity_delta,reason\nA,1,"open',
    'item_code,quantity_delta,reason\nA,1,',
    'item_code,quantity_delta,reason,extra\nA,1,ok,x',
  ])("rejects the entire malformed import", (csv) => expect(() => parseAdjustmentCsv(csv)).toThrow());
  it("round trips the sample with real codes and negative deltas", () => {
    expect(parseAdjustmentCsv(adjustmentSampleCsv(["A", "B"])) .map((row) => row.quantity_delta)).toEqual([1, -1]);
  });
  it("bounds row count and file size", () => {
    expect(() => parseAdjustmentCsv("x".repeat(1_000_001))).toThrow();
    expect(() => parseAdjustmentCsv("item_code,quantity_delta,reason\n" + Array.from({ length: 1001 }, (_, index) => `A${index},1,ok`).join("\n"))).toThrow();
  });
});
