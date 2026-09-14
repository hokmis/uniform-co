import { describe, expect, it } from "vitest";
import { normalizeWorkbenchId, resolveWorkbenchTabId, shouldMountRetainedPanel } from "./module-workbench";

describe("module workbench interface", () => {
  const tabs = [
    { id: "list", label: "清單" },
    { id: "form", label: "表單" },
  ];

  it("keeps a valid requested tab and falls back deterministically", () => {
    expect(resolveWorkbenchTabId(tabs, "form", "list")).toBe("form");
    expect(resolveWorkbenchTabId(tabs, "missing", "form")).toBe("form");
    expect(resolveWorkbenchTabId(tabs, null)).toBe("list");
  });

  it("normalizes DOM id fragments and rejects an empty interface", () => {
    expect(normalizeWorkbenchId(" HR / Corrections ")).toBe("hr-corrections");
    expect(() => resolveWorkbenchTabId([], null)).toThrow("at least one tab");
  });

  it("mounts only active or previously visited panels unless eager mounting is explicit", () => {
    const visited = new Set(["list"]);

    expect(shouldMountRetainedPanel("form", "form", visited, "active")).toBe(true);
    expect(shouldMountRetainedPanel("list", "form", visited, "active")).toBe(false);
    expect(shouldMountRetainedPanel("list", "form", visited, "visited")).toBe(true);
    expect(shouldMountRetainedPanel("audit", "form", visited, "visited")).toBe(false);
    expect(shouldMountRetainedPanel("audit", "form", visited, "all")).toBe(true);
  });
});
