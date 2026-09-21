import InventoryManagementPanel from "../InventoryManagementPanel";
import { useMemo } from "react";
import ModuleWorkbench from "../ModuleWorkbench";
import dynamic from "next/dynamic";
import RetainedPanelSet from "../RetainedPanelSet";
import WorkspacePanelLoading from "../WorkspacePanelLoading";
import type { WorkspaceId } from "./workspace-config";

const WarehouseShipmentPanel = dynamic(() => import("../WarehouseShipmentPanel"), { loading: () => <WorkspacePanelLoading label="正在載入發貨作業" /> });
const StocktakePanel = dynamic(() => import("../StocktakePanel"), { loading: () => <WorkspacePanelLoading label="正在載入庫存盤點" /> });
const WarehouseTransferCorrectionPanel = dynamic(() => import("../WarehouseTransferCorrectionPanel"), { loading: () => <WorkspacePanelLoading label="正在載入調庫更正" /> });
const StocktakeCorrectionPanel = dynamic(() => import("../StocktakeCorrectionPanel"), { loading: () => <WorkspacePanelLoading label="正在載入盤點更正" /> });

type Props = { activeModule: string; onNavigate: (workspaceId: WorkspaceId, anchor: string) => void };

export default function WarehouseWorkspace({ activeModule, onNavigate }: Props) {
  const panels = useMemo(() => [
    { id: "warehouse-inventory-title", content: <InventoryManagementPanel headingId="warehouse-inventory-title" onNavigate={onNavigate} /> },
    {
      id: "warehouse-control-title",
      content: <>
        <div className="workspace-section-heading">
          <div><p className="eyebrow">FULFILLMENT</p><h2 id="warehouse-control-title">發貨作業</h2></div>
          <p>依需求單處理倉庫發貨；倉庫只填寫實際調庫量，正式庫存異動由受保護 RPC 完成。</p>
        </div>
        <WarehouseShipmentPanel />
      </>,
    },
    { id: "warehouse-stocktake-title", content: <ModuleWorkbench
      idPrefix="warehouse-stocktake"
      eyebrow="STOCKTAKE & CORRECTION"
      title="盤點與倉庫更正"
      headingId="warehouse-stocktake-title"
      description="先依任務選擇正式盤點、調庫更正或盤點更正；每條流程都保留原始來源、理由與版本 fencing。"
      tabs={[
        { id: "stocktake", label: "庫存盤點", content: <StocktakePanel /> },
        { id: "transfer-correction", label: "調庫更正", content: <WarehouseTransferCorrectionPanel /> },
        { id: "stocktake-correction", label: "盤點更正", content: <StocktakeCorrectionPanel /> },
      ]}
    /> },
  ], [onNavigate]);

  return (
    <div className="workspace-sections">
      <RetainedPanelSet
        idPrefix="workspace-module"
        activePanelId={activeModule}
        panelClassName="workspace-section"
        panels={panels}
      />
    </div>
  );
}
