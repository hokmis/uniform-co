import HrRequestWorkbench from "../HrRequestWorkbench";
import { useMemo } from "react";
import ModuleWorkbench from "../ModuleWorkbench";
import dynamic from "next/dynamic";
import RetainedPanelSet from "../RetainedPanelSet";
import WorkspacePanelLoading from "../WorkspacePanelLoading";

const HrRequestHistoryPanel = dynamic(() => import("../HrRequestHistoryPanel"), { loading: () => <WorkspacePanelLoading label="正在載入需求查詢" /> });
const ReplenishmentPanel = dynamic(() => import("../ReplenishmentPanel"), { loading: () => <WorkspacePanelLoading label="正在載入額外補庫" /> });
const ReturnPanel = dynamic(() => import("../ReturnPanel"), { loading: () => <WorkspacePanelLoading label="正在載入員工退回" /> });
const HrIssueCorrectionPanel = dynamic(() => import("../HrIssueCorrectionPanel"), { loading: () => <WorkspacePanelLoading label="正在載入發放更正" /> });
const ReturnCorrectionPanel = dynamic(() => import("../ReturnCorrectionPanel"), { loading: () => <WorkspacePanelLoading label="正在載入退回更正" /> });
const EmployeeManagementPanel = dynamic(() => import("../EmployeeManagementPanel"), { loading: () => <WorkspacePanelLoading label="正在載入員工主檔" /> });

type Props = { activeModule: string };

export default function HrWorkspace({ activeModule }: Props) {
  const panels = useMemo(() => [
    { id: "hr-request-title", content: <ModuleWorkbench
      idPrefix="hr-request"
      eyebrow="REQUEST WORKBENCH"
      title="需求與發放準備"
      headingId="hr-request-title"
      description="依任務切換需求單、補庫或員工退回；送出與正式過帳仍由各自受保護 RPC 依兩倉數量與來源單據驗證。"
      tabs={[
        { id: "request", label: "新增員工制服需求單", content: <HrRequestWorkbench /> },
        { id: "history", label: "需求查詢", content: <HrRequestHistoryPanel /> },
        { id: "replenishment", label: "額外補庫", content: <ReplenishmentPanel /> },
        { id: "return", label: "員工退回", content: <ReturnPanel /> },
      ]}
    /> },
    { id: "hr-correction-title", content: <ModuleWorkbench
      idPrefix="hr-correction"
      eyebrow="CORRECTIONS"
      title="人資發放與退回更正"
      headingId="hr-correction-title"
      description="正式過帳後以來源明細建立後續更正，不直接改寫原始單據；所有差額仍由受保護 RPC 驗證與過帳。"
      tabs={[
        { id: "issue-correction", label: "發放更正", content: <HrIssueCorrectionPanel /> },
        { id: "return-correction", label: "退回更正", content: <ReturnCorrectionPanel /> },
      ]}
    /> },
    { id: "hr-employee-title", content: <EmployeeManagementPanel /> },
  ], []);

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
