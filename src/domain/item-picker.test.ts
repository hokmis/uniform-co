import { describe, expect, it } from "vitest";
import { canUseCustomItemCode, clearItemPickerSelection, filterItemOptions, itemOptionSizes, selectVisibleItemOptions, selectedItemsPreview, shouldDismissItemPicker, toggleItemSelection } from "./item-picker";

const items = [
  { id: "1", code: "SHIRT-M", name: "制服上衣", size: "M" },
  { id: "2", code: "PANTS-L", name: "制服長褲", size: "L" },
];

describe("item picker", () => {
  it("searches by code, name, and size without case sensitivity", () => {
    expect(filterItemOptions(items, "shirt").map((item) => item.id)).toEqual(["1"]);
    expect(filterItemOptions(items, "長褲").map((item) => item.id)).toEqual(["2"]);
    expect(filterItemOptions(items, "m").map((item) => item.id)).toEqual(["1"]);
  });

  it("matches every search term across code, name, and size regardless of term order", () => {
    expect(filterItemOptions(items, "M 上衣").map((item) => item.id)).toEqual(["1"]);
    expect(filterItemOptions(items, "長褲 PANTS").map((item) => item.id)).toEqual(["2"]);
    expect(filterItemOptions(items, "M 長褲")).toEqual([]);
  });

  it("searches employee number, name, institution, and department in any term order", () => {
    const employees = [
      { id: "employee-1", code: "E0271", name: "王小明", detail: "台北院區｜護理部" },
      { id: "employee-2", code: "E1933", name: "陳小華", detail: "台中院區｜行政部" },
    ];

    expect(filterItemOptions(employees, "E0271 護理部").map(({ id }) => id)).toEqual(["employee-1"]);
    expect(filterItemOptions(employees, "台中院區 陳小華").map(({ id }) => id)).toEqual(["employee-2"]);
    expect(filterItemOptions(employees, "護理部 E1933")).toEqual([]);
  });

  it("combines the selected size filter with the text search", () => {
    expect(filterItemOptions(items, "", 100, { size: "M" }).map((item) => item.id)).toEqual(["1"]);
    expect(filterItemOptions(items, "長褲", 100, { size: "M" })).toEqual([]);
    expect(filterItemOptions(items, "長褲", 100, { size: "L" }).map((item) => item.id)).toEqual(["2"]);
  });

  it("offers unique non-empty size facets in a predictable order", () => {
    expect(itemOptionSizes([
      ...items,
      { id: "3", code: "SHIRT-M-2", name: "制服上衣 2", size: "M" },
      { id: "4", code: "BELT", name: "皮帶", size: " " },
    ])).toEqual(["L", "M"]);
  });

  it("keeps results bounded and toggles multi-selection without duplicates", () => {
    expect(filterItemOptions(items, "", 1)).toHaveLength(1);
    expect(toggleItemSelection(["1"], "2")).toEqual(["1", "2"]);
    expect(toggleItemSelection(["1", "2"], "1")).toEqual(["2"]);
  });

  it("selects every currently filtered item while preserving earlier selections", () => {
    expect(selectVisibleItemOptions(["2"], ["1", "2", "3"])).toEqual(["2", "1", "3"]);
  });

  it("summarizes selected items in selection order and keeps unknown ids removable", () => {
    expect(selectedItemsPreview(items, ["2", "missing", "1"], 2)).toEqual({
      items: [
        { id: "2", label: "PANTS-L｜制服長褲｜L" },
        { id: "missing", label: "missing" },
      ],
      totalCount: 3,
      hiddenCount: 1,
    });
  });

  it("handles an empty or zero-limit preview without losing the selected count", () => {
    expect(selectedItemsPreview(items, ["1"], 0)).toEqual({ items: [], totalCount: 1, hiddenCount: 1 });
    expect(selectedItemsPreview(items, [], 5)).toEqual({ items: [], totalCount: 0, hiddenCount: 0 });
  });

  it("clears a single selection without changing the multi-select value shape", () => {
    expect(clearItemPickerSelection(false)).toBe("");
    expect(clearItemPickerSelection(true)).toEqual([]);
  });

  it("dismisses the picker on Escape from any focused control, but not while disabled", () => {
    expect(shouldDismissItemPicker("Escape", false)).toBe(true);
    expect(shouldDismissItemPicker("Enter", false)).toBe(false);
    expect(shouldDismissItemPicker("Escape", true)).toBe(false);
  });

  it("offers exact-code lookup only when the query does not match an active item", () => {
    expect(canUseCustomItemCode(items, "OLD-SHIRT-M", true, false)).toBe(true);
    expect(canUseCustomItemCode(items, "shirt-m", true, false)).toBe(false);
    expect(canUseCustomItemCode(items, "制服", true, false)).toBe(false);
    expect(canUseCustomItemCode(items, "OLD-SHIRT-M", false, false)).toBe(false);
    expect(canUseCustomItemCode(items, "OLD-SHIRT-M", true, true)).toBe(false);
    expect(canUseCustomItemCode(items, "  ", true, false)).toBe(false);
  });
});
