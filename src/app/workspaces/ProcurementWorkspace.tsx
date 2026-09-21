import { useMemo } from "react";
import ModuleWorkbench from "../ModuleWorkbench";
import dynamic from "next/dynamic";
import RetainedPanelSet from "../RetainedPanelSet";
import SeasonalProcurementPanel from "../SeasonalProcurementPanel";
import WorkspacePanelLoading from "../WorkspacePanelLoading";

const ProcurementReasonCodePanel = dynamic(() => import("../ProcurementReasonCodePanel"), { loading: () => <WorkspacePanelLoading label="正在載入差異原因碼" /> });
const PurchaseReceiptCorrectionPanel = dynamic(() => import("../PurchaseReceiptCorrectionPanel"), { loading: () => <WorkspacePanelLoading label="正在載入入庫更正" /> });
const PurchaseReceiptPanel = dynamic(() => import("../PurchaseReceiptPanel"), { loading: () => <WorkspacePanelLoading label="正在載入採購入庫" /> });

type Props = { activeModule: string };

export default function ProcurementWorkspace({ activeModule }: Props) {
  const panels = useMemo(() => [
    { id: "procurement-decision-title", content: <ModuleWorkbench
      idPrefix="procurement-decision"
      eyebrow="PURCHASE DECISION"
      title="採購決策與差異"
      headingId="procurement-decision-title"
      description="日常採購決策與系統管理用的差異原因碼分開操作；採購量仍受 CEO 核准量、供應商與 MOQ 契約限制。"
      tabs={[
        { id: "decision", label: "採購決策", content: <SeasonalProcurementPanel /> },
        { id: "reason-codes", label: "差異原因碼", content: <ProcurementReasonCodePanel /> },
      ]}
    /> },
    { id: "procurement-receipt-title", content: <ModuleWorkbench
      idPrefix="procurement-receipt"
      eyebrow="RECEIPT POSTING"
      title="採購入庫與更正"
      headingId="procurement-receipt-title"
      description="新到貨使用採購入庫草稿；已完成的到貨、合格或拒收數量只能由獨立更正流程調整。"
      tabs={[
        { id: "receipt", label: "採購入庫", content: <PurchaseReceiptPanel /> },
        { id: "correction", label: "入庫更正", content: <PurchaseReceiptCorrectionPanel /> },
      ]}
    /> },
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
