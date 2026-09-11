import EmployeeManagementPanel from "../EmployeeManagementPanel";
import HrIssueCorrectionPanel from "../HrIssueCorrectionPanel";
import HrRequestWorkbench from "../HrRequestWorkbench";
import ModuleWorkbench from "../ModuleWorkbench";
import ReplenishmentPanel from "../ReplenishmentPanel";
import RetainedPanelSet from "../RetainedPanelSet";
import ReturnCorrectionPanel from "../ReturnCorrectionPanel";
import ReturnPanel from "../ReturnPanel";

type Props = { activeModule: string };

export default function HrWorkspace({ activeModule }: Props) {
  return (
    <div className="workspace-sections">
      <RetainedPanelSet
        idPrefix="workspace-module"
        activePanelId={activeModule}
        panelClassName="workspace-section"
        panels={[
          { id: "hr-request-title", content: <ModuleWorkbench
          idPrefix="hr-request"
          eyebrow="REQUEST WORKBENCH"
          title="需求與發放準備"
          headingId="hr-request-title"
          description="依任務切換需求單、補庫或員工退回；送出與正式過帳仍由各自受保護 RPC 依兩倉數量與來源單據驗證。"
          tabs={[
            { id: "request", label: "制服需求", content: <HrRequestWorkbench /> },
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
        ]}
      />
    </div>
  );
}
