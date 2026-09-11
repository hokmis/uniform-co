"use client";

import { useState, type KeyboardEvent, type ReactNode } from "react";
import { normalizeWorkbenchId, resolveWorkbenchTabId, type PanelMountPolicy } from "@/src/domain/module-workbench";
import RetainedPanelSet from "./RetainedPanelSet";

export type ModuleWorkbenchTab = {
  id: string;
  label: string;
  content: ReactNode;
  badge?: string;
};

type NavigationProps = {
  idPrefix: string;
  ariaLabel: string;
  tabs: readonly Omit<ModuleWorkbenchTab, "content">[];
  activeTabId: string;
  onTabChange: (tabId: string) => void;
};

export function ModuleWorkbenchNavigation({ idPrefix, ariaLabel, tabs, activeTabId, onTabChange }: NavigationProps) {
  const normalizedPrefix = normalizeWorkbenchId(idPrefix) || "module";

  function focusTab(tabId: string) {
    window.setTimeout(() => document.getElementById(`${normalizedPrefix}-tab-${normalizeWorkbenchId(tabId)}`)?.focus(), 0);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabs.length;
    if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextTabId = tabs[nextIndex].id;
    onTabChange(nextTabId);
    focusTab(nextTabId);
  }

  return (
    <nav className="module-workbench-tabs" aria-label={ariaLabel} role="tablist">
      {tabs.map((tab, index) => {
        const tabId = `${normalizedPrefix}-tab-${normalizeWorkbenchId(tab.id)}`;
        const panelId = `${normalizedPrefix}-panel-${normalizeWorkbenchId(tab.id)}`;
        return <button
          key={tab.id}
          id={tabId}
          className={activeTabId === tab.id ? "active" : ""}
          type="button"
          role="tab"
          aria-selected={activeTabId === tab.id}
          aria-controls={panelId}
          tabIndex={activeTabId === tab.id ? 0 : -1}
          onClick={() => onTabChange(tab.id)}
          onKeyDown={(event) => handleKeyDown(event, index)}
        >
          <span>{tab.label}</span>
          {tab.badge ? <small>{tab.badge}</small> : null}
        </button>;
      })}
    </nav>
  );
}

type Props = {
  idPrefix: string;
  eyebrow: string;
  title: string;
  description: string;
  headingId?: string;
  tabs: readonly ModuleWorkbenchTab[];
  defaultTabId?: string;
  activeTabId?: string;
  onTabChange?: (tabId: string) => void;
  actions?: ReactNode;
  feedback?: ReactNode;
  mountPolicy?: PanelMountPolicy;
};

export default function ModuleWorkbench({
  idPrefix,
  eyebrow,
  title,
  description,
  headingId,
  tabs,
  defaultTabId,
  activeTabId,
  onTabChange,
  actions,
  feedback,
  mountPolicy = "visited",
}: Props) {
  const normalizedPrefix = normalizeWorkbenchId(idPrefix) || "module";
  const definitions = tabs.map(({ id, label }) => ({ id, label }));
  const [internalTabId, setInternalTabId] = useState(() => resolveWorkbenchTabId(definitions, null, defaultTabId));
  const selectedTabId = resolveWorkbenchTabId(definitions, activeTabId ?? internalTabId, defaultTabId);

  function selectTab(tabId: string) {
    const nextTabId = resolveWorkbenchTabId(definitions, tabId, defaultTabId);
    if (activeTabId === undefined) setInternalTabId(nextTabId);
    onTabChange?.(nextTabId);
  }

  return (
    <div className="workspace-sections module-workbench">
      <section className="panel module-workbench-header" aria-label={title}>
        <div className="panel-heading">
          <div>
            <p className="eyebrow">{eyebrow}</p>
            <h2 id={headingId}>{title}</h2>
            <p className="auth-message">{description}</p>
          </div>
          {actions ? <div className="module-workbench-actions">{actions}</div> : null}
        </div>
        <ModuleWorkbenchNavigation
          idPrefix={normalizedPrefix}
          ariaLabel={`${title}功能`}
          tabs={tabs.map(({ id, label, badge }) => ({ id, label, badge }))}
          activeTabId={selectedTabId}
          onTabChange={selectTab}
        />
      </section>
      {feedback}
      <RetainedPanelSet
        idPrefix={normalizedPrefix}
        activePanelId={selectedTabId}
        mountPolicy={mountPolicy}
        panelClassName="module-workbench-content"
        panels={tabs.map(({ id, content }) => ({ id, content }))}
      />
    </div>
  );
}
