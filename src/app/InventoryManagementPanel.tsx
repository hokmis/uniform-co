"use client";

import { useState } from "react";
import InventoryAvailabilityPanel from "./InventoryAvailabilityPanel";
import InventoryCalculator from "./InventoryCalculator";
import DurableImportPanel from "./DurableImportPanel";
import InventoryHistoryExportPanel from "./InventoryHistoryExportPanel";
import InventoryOperationHub from "./InventoryOperationHub";
import ModuleWorkbench from "./ModuleWorkbench";
import type { WorkspaceId } from "./workspaces/workspace-config";

type Props = {
  onNavigate: (workspaceId: WorkspaceId, anchor: string) => void;
  headingId?: string;
};
type InventoryTab = "availability" | "operations" | "opening" | "history" | "calculator";

export default function InventoryManagementPanel({ onNavigate, headingId }: Props) {
  const [activeTab, setActiveTab] = useState<InventoryTab>("availability");

  return (
    <ModuleWorkbench
      idPrefix="inventory-management"
      eyebrow="INVENTORY MANAGEMENT"
      title="庫存管理"
      headingId={headingId}
      description="先從兩倉可用量掌握現況，再進入異動流程、期初匯入、歷史匯出或規則試算；正式餘額只由受保護流水更新。"
      activeTabId={activeTab}
      onTabChange={(tabId) => setActiveTab(tabId as InventoryTab)}
      tabs={[
        { id: "availability", label: "兩倉可用量", content: <InventoryAvailabilityPanel /> },
        { id: "operations", label: "異動操作", content: <InventoryOperationHub onNavigate={onNavigate} onOpenOpeningImport={() => setActiveTab("opening")} /> },
        {
          id: "opening",
          label: "期初庫存",
          content: <DurableImportPanel
            allowedImportTypes={["OPENING_BALANCE"]}
            recoveryStorageKey="uniform-co:durable-import-opening-recovery"
          />,
        },
        { id: "history", label: "歷史匯出", content: <InventoryHistoryExportPanel /> },
        { id: "calculator", label: "規則試算", content: <InventoryCalculator /> },
      ]}
    />
  );
}
