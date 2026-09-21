import { describe, expect, it } from "vitest";
import { createReadRequestController, hasCurrentReadSnapshot, isReadPendingForSelection, shouldPreserveReadSnapshot, staleReadSnapshotMessage } from "./read-refresh";

describe("read refresh snapshot policy", () => {
  const rows = [{ id: "row-1" }];

  it("preserves a previous snapshot only for transient session sync errors", () => {
    expect(shouldPreserveReadSnapshot(rows, [{ code: "PGRST301", message: "JWT expired" }])).toBe(true);
    expect(shouldPreserveReadSnapshot(rows, [{ code: "42501", message: "permission denied" }])).toBe(false);
    expect(shouldPreserveReadSnapshot(rows, [{ code: "PGRST301", message: "JWT expired" }, { code: "42501" }])).toBe(false);
  });

  it("does not preserve an empty snapshot", () => {
    expect(shouldPreserveReadSnapshot([], [{ code: "PGRST301", message: "JWT expired" }])).toBe(false);
    expect(staleReadSnapshotMessage("商品清單")).toContain("仍顯示上次已載入資料");
  });

  it("only exposes a cached read snapshot to the ready scope that loaded it", () => {
    expect(hasCurrentReadSnapshot(true, "account-a", "account-a")).toBe(true);
    expect(hasCurrentReadSnapshot(true, "account-a", "account-b")).toBe(false);
    expect(hasCurrentReadSnapshot(false, "account-a", "account-a")).toBe(false);
    expect(hasCurrentReadSnapshot(true, "account-a", null)).toBe(false);
  });

  it("fences an older read and invalidates a read after a mutation", () => {
    const controller = createReadRequestController();
    const first = controller.begin();
    const second = controller.begin();
    expect(controller.isCurrent(first)).toBe(false);
    expect(controller.isCurrent(second)).toBe(true);
    controller.invalidate();
    expect(controller.isCurrent(second)).toBe(false);
  });

  it("does not keep a dependent read spinner after its selection is cleared or replaced", () => {
    expect(isReadPendingForSelection("warehouse-a", "warehouse-a", true)).toBe(true);
    expect(isReadPendingForSelection(null, "warehouse-a", true)).toBe(false);
    expect(isReadPendingForSelection("warehouse-b", "warehouse-a", true)).toBe(false);
    expect(isReadPendingForSelection("warehouse-a", "warehouse-a", false)).toBe(false);
  });
});
