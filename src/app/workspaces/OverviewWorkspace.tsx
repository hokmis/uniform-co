import OverviewDashboard from "../OverviewDashboard";
import { useMemo } from "react";
import dynamic from "next/dynamic";
import RetainedPanelSet from "../RetainedPanelSet";
import WorkspacePanelLoading from "../WorkspacePanelLoading";
import type { WorkspaceId } from "./workspace-config";

const OrganizationManagementPanel = dynamic(() => import("../OrganizationManagementPanel"), { loading: () => <WorkspacePanelLoading label="正在載入組織主檔" /> });
const ProductManagementPanel = dynamic(() => import("../ProductManagementPanel"), { loading: () => <WorkspacePanelLoading label="正在載入商品管理" /> });
const DurableImportPanel = dynamic(() => import("../DurableImportPanel"), { loading: () => <WorkspacePanelLoading label="正在載入耐久匯入" /> });

type Props = { activeModule: string; onNavigate: (workspaceId: WorkspaceId, anchor: string) => void };

export default function OverviewWorkspace({ activeModule, onNavigate }: Props) {
  const panels = useMemo(() => [
    { id: "overview-dashboard-title", content: <OverviewDashboard onNavigate={onNavigate} /> },
    {
      id: "overview-access-title",
      className: "workspace-section",
      content: <>
        <div className="workspace-section-heading">
          <div><p className="eyebrow">ACCESS &amp; FOUNDATION</p><h2 id="overview-access-title">主檔與資料基礎</h2></div>
          <p>所有業務工作區共用這裡的課室部門與報局單位主檔；商品與供應商資料已集中到商品管理，帳號與角色請至左側帳號管理。</p>
        </div>
        <OrganizationManagementPanel />
      </>,
    },
    {
      id: "overview-products-title",
      className: "workspace-section",
      content: <>
        <div className="workspace-section-heading">
          <div><p className="eyebrow">PRODUCT MANAGEMENT</p><h2 id="overview-products-title">商品管理</h2></div>
          <p>集中維護制服品號、供應商與供應商品號 MOQ；商品資料仍由主檔 RPC 驗證並供庫存與採購共用。</p>
        </div>
        <ProductManagementPanel />
      </>,
    },
    {
      id: "overview-import-title",
      className: "workspace-section",
      content: <>
        <div className="workspace-section-heading">
          <div><p className="eyebrow">DURABLE IMPORT</p><h2 id="overview-import-title">耐久匯入</h2></div>
          <p>機構、部門與員工的大檔案匯入保留批次、差異與確認狀態；商品與期初庫存已分流至各自管理模組。</p>
        </div>
        <DurableImportPanel
          allowedImportTypes={["INSTITUTIONS", "DEPARTMENTS", "EMPLOYEES"]}
          recoveryStorageKey="uniform-co:durable-import-foundation-recovery"
        />
      </>,
    },
  ], [onNavigate]);

  return (
    <div className="workspace-sections">
      <RetainedPanelSet
        idPrefix="workspace-module"
        activePanelId={activeModule}
        panels={panels}
      />
    </div>
  );
}
