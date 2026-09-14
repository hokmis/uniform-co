export type ModuleWorkbenchTabDefinition = {
  id: string;
  label: string;
};

export type PanelMountPolicy = "active" | "visited" | "all";

export function normalizeWorkbenchId(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}
export function resolveWorkbenchTabId(
  tabs: readonly ModuleWorkbenchTabDefinition[],
  requestedTabId: string | null | undefined,
  defaultTabId?: string,
): string {
  if (tabs.length === 0) throw new Error("Module workbench requires at least one tab.");
  if (requestedTabId && tabs.some((tab) => tab.id === requestedTabId)) return requestedTabId;
  if (defaultTabId && tabs.some((tab) => tab.id === defaultTabId)) return defaultTabId;
  return tabs[0].id;
}

export function shouldMountRetainedPanel(
  panelId: string,
  activePanelId: string,
  visitedPanelIds: ReadonlySet<string>,
  mountPolicy: PanelMountPolicy,
): boolean {
  if (mountPolicy === "all") return true;
  if (panelId === activePanelId) return true;
  return mountPolicy === "visited" && visitedPanelIds.has(panelId);
}
