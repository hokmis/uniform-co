import { describe, expect, it } from "vitest";
import { appendReplenishmentItems, type ReplenishmentItemLine } from "./replenishment-item-selection";

describe("replenishment item selection", () => {
  it("fills the initial blank row, then adds other checked items with quantity one", () => {
    expect(appendReplenishmentItems([{ itemId: "", quantity: 1 }], ["item-1", "item-2"])).toEqual([
      { itemId: "item-1", quantity: 1 },
      { itemId: "item-2", quantity: 1 },
    ]);
  });

  it("preserves edited quantities and does not duplicate existing or repeated selections", () => {
    const existing: ReplenishmentItemLine[] = [
      { itemId: "item-1", quantity: 7 },
      { itemId: "", quantity: 3 },
    ];

    expect(appendReplenishmentItems(existing, ["item-1", "item-2", "item-2", "", "item-3"])).toEqual([
      { itemId: "item-1", quantity: 7 },
      { itemId: "item-2", quantity: 1 },
      { itemId: "item-3", quantity: 1 },
    ]);
  });

  it("leaves the request lines unchanged when no checkbox is selected", () => {
    const existing = [{ itemId: "item-1", quantity: 4 }];
    expect(appendReplenishmentItems(existing, [])).toEqual(existing);
  });
});
