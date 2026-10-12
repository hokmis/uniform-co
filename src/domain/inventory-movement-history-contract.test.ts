import { describe, expect, it } from "vitest";

describe("inventory movement recovery", () => {
  const source = readFileSync(new URL("../app/InventoryMovementHistoryPanel.tsx", import.meta.url), "utf8");
  it("handles rejected reads and fences the item options by account", () => {
    expect(source).toContain("itemsSnapshotAccount === accountId");
    expect(source).toContain(".catch(() => {");
    expect(source).toContain("庫存異動紀錄暫時無法載入，請檢查連線後按「重新整理」。");
    expect(source).toContain("} catch {");
    expect(source).not.toContain("error.message");
  });
});
import { readFileSync } from "node:fs";

describe("warehouse inventory movement history", () => {
  it("is reachable from inventory management and reads all pages for one item without mutating balances", () => {
    const panel = readFileSync(new URL("../app/InventoryMovementHistoryPanel.tsx", import.meta.url), "utf8");
    const management = readFileSync(new URL("../app/InventoryManagementPanel.tsx", import.meta.url), "utf8");
    expect(management).toContain('label: "庫存異動紀錄"');
    expect(panel).toContain('from("v_inventory_history")');
    expect(panel).toContain("loadInventoryHistoryItemOptions");
    expect(panel).toContain("SearchableItemPicker");
    expect(panel).toContain('.eq("item_code", itemCode)');
    expect(panel).toContain(".range(");
    expect(panel).toContain("usePanelActivity()");
    expect(panel).not.toContain('from("inventory_balances")');
  });

  it("uses one picker for historical selection and exact-code lookup", () => {
    const panel = readFileSync(new URL("../app/InventoryMovementHistoryPanel.tsx", import.meta.url), "utf8");

    expect(panel).toContain("allowCustomValue");
    expect(panel).toContain('customValueActionLabel="以完整品號查詢"');
    expect(panel).not.toContain("完整品號（含停用品號）");
    expect(panel).not.toContain("function search()");
  });
});
