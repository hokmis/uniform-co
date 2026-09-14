"use client";

import { useState, type ReactNode } from "react";
import { normalizeWorkbenchId, shouldMountRetainedPanel, type PanelMountPolicy } from "@/src/domain/module-workbench";

export type RetainedPanel = {
  id: string;
  content: ReactNode;
  className?: string;
  panelId?: string;
  tabId?: string;
};

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
  const [retention, setRetention] = useState(() => ({
    activePanelId,
    visitedPanelIds: new Set(activePanelId ? [activePanelId] : []),
  }));
  let visitedPanelIds: ReadonlySet<string> = retention.visitedPanelIds;
  if (retention.activePanelId !== activePanelId) {
    visitedPanelIds = activePanelId
      ? new Set([...retention.visitedPanelIds, activePanelId])
      : retention.visitedPanelIds;
    setRetention({ activePanelId, visitedPanelIds: new Set(visitedPanelIds) });
  }

  return panels.map((panel) => {
    if (!shouldMountRetainedPanel(panel.id, activePanelId, visitedPanelIds, mountPolicy)) return null;
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
        {panel.content}
      </div>
    );
  });
}
