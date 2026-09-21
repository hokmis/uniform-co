"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { normalizeWorkbenchId, rememberVisitedPanel, shouldMountRetainedPanel, type PanelMountPolicy } from "@/src/domain/module-workbench";

export type RetainedPanel = {
  id: string;
  content: ReactNode;
  className?: string;
  panelId?: string;
  tabId?: string;
};

const PanelActivityContext = createContext(true);

export function usePanelActivity(): boolean {
  return useContext(PanelActivityContext);
}

type Props = {
  idPrefix: string;
  activePanelId: string;
  panels: readonly RetainedPanel[];
  mountPolicy?: PanelMountPolicy;
  panelClassName?: string;
  activePanelClassName?: string;
};

function classNames(...values: Array<string | undefined | false>): string | undefined {
  const value = values.filter(Boolean).join(" ");
  return value || undefined;
}

export default function RetainedPanelSet({
  idPrefix,
  activePanelId,
  panels,
  mountPolicy = "visited",
  panelClassName,
  activePanelClassName,
}: Props) {
  const normalizedPrefix = normalizeWorkbenchId(idPrefix) || "module";
  const parentActive = usePanelActivity();
  const [visitedPanelIds, setVisitedPanelIds] = useState<ReadonlySet<string>>(
    () => new Set(activePanelId ? [activePanelId] : []),
  );

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setVisitedPanelIds((current) => rememberVisitedPanel(current, activePanelId));
    });
    return () => { active = false; };
  }, [activePanelId]);

  // Include the active panel immediately on the first render after a switch;
  // the microtask above persists it for later switches without updating state
  // during render or delaying the first visible panel.
  const renderedVisitedPanelIds = rememberVisitedPanel(visitedPanelIds, activePanelId);

  return panels.map((panel) => {
    if (!shouldMountRetainedPanel(panel.id, activePanelId, renderedVisitedPanelIds, mountPolicy)) return null;
    const isActive = panel.id === activePanelId;
    const normalizedPanelId = normalizeWorkbenchId(panel.id);
    return (
      <div
        key={panel.id}
        id={panel.panelId ?? `${normalizedPrefix}-panel-${normalizedPanelId}`}
        className={classNames(panelClassName, panel.className, isActive && activePanelClassName)}
        role="tabpanel"
        aria-labelledby={panel.tabId ?? `${normalizedPrefix}-tab-${normalizedPanelId}`}
        hidden={!isActive}
      >
        <PanelActivityContext.Provider value={parentActive && isActive}>
          {panel.content}
        </PanelActivityContext.Provider>
      </div>
    );
  });
}
