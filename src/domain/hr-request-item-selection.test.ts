import { describe, expect, it } from "vitest";
import { appendHrRequestItemsForEmployee } from "./hr-request-item-selection";
import type { HrRequestLineSelection } from "./hr-request-workflow";

describe("HR request bulk item selection", () => {
  it("fills an empty row and adds checked items for the selected employee", () => {
    const ids = ["line-2", "line-3"];
    expect(appendHrRequestItemsForEmployee(
      [{ lineId: "line-1", employeeId: "", itemId: "", quantity: 1 }],
      "employee-1",
      ["item-1", "item-2"],
      () => ids.shift() ?? "unused",
    )).toEqual([
      { lineId: "line-1", employeeId: "employee-1", itemId: "item-1", quantity: 1 },
      { lineId: "line-2", employeeId: "employee-1", itemId: "item-2", quantity: 1 },
    ]);
  });

  it("preserves edited lines, skips duplicate employee-item pairs, and allows the same item for another employee", () => {
    const existing: HrRequestLineSelection[] = [
      { lineId: "line-1", employeeId: "employee-1", itemId: "item-1", quantity: 4 },
      { lineId: "line-2", employeeId: "employee-2", itemId: "item-1", quantity: 2 },
    ];

    expect(appendHrRequestItemsForEmployee(existing, "employee-1", ["item-1", "item-2", "item-2"], () => "line-3")).toEqual([
      existing[0],
      existing[1],
      { lineId: "line-3", employeeId: "employee-1", itemId: "item-2", quantity: 1 },
    ]);
  });

  it("adds nothing without a selected employee or checked items", () => {
    const existing = [{ lineId: "line-1", employeeId: "employee-1", itemId: "item-1", quantity: 3 }];

    expect(appendHrRequestItemsForEmployee(existing, "", ["item-2"], () => "line-2")).toEqual(existing);
    expect(appendHrRequestItemsForEmployee(existing, "employee-1", [], () => "line-2")).toEqual(existing);
  });
});
