import { describe, expect, it } from "vitest";
import {
  normalizeCatalogPageSize,
  resolveCatalogPageWindow,
  resolveVisibleCatalogColumnIds,
  toggleCatalogColumnId,
} from "./management-catalog";

describe("management catalog interface", () => {
  it("normalizes page sizes and clamps page windows", () => {
    expect(normalizeCatalogPageSize(50, [10, 25, 50, 100], 25)).toBe(50);
    expect(normalizeCatalogPageSize(99, [10, 25, 50, 100], 25)).toBe(25);
    expect(resolveCatalogPageWindow(63, 99, 25)).toEqual({ currentPage: 3, pageCount: 3, start: 51, end: 63 });
    expect(resolveCatalogPageWindow(0, -1, 0)).toEqual({ currentPage: 1, pageCount: 1, start: 0, end: 0 });
  });

  it("keeps locked columns visible and ignores unknown ids", () => {
    expect(resolveVisibleCatalogColumnIds(["code", "name", "actions"], ["unknown", "name"], ["code", "actions"]))
      .toEqual(["code", "name", "actions"]);
    expect(toggleCatalogColumnId(["code", "name", "actions"], ["code", "name", "actions"], "actions", ["code", "actions"]))
      .toEqual(["code", "name", "actions"]);
  });

  it("never leaves a catalog without a visible column", () => {
    expect(toggleCatalogColumnId(["code", "name"], ["code"], "code")).toEqual(["code"]);
    expect(resolveVisibleCatalogColumnIds(["code", "name"], [])).toEqual(["code"]);
  });
});
