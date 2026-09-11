import ModuleWorkbench from "../ModuleWorkbench";
import SeasonalApprovalPanel from "../SeasonalApprovalPanel";
import SeasonalCampaignPanel from "../SeasonalCampaignPanel";
import SeasonalDemandPanel from "../SeasonalDemandPanel";
import RetainedPanelSet from "../RetainedPanelSet";

type Props = { activeModule: string };

export default function SeasonalWorkspace({ activeModule }: Props) {
  return (
    <div className="workspace-sections">
      <RetainedPanelSet
        idPrefix="workspace-module"
        activePanelId={activeModule}
        panelClassName="workspace-section"
        panels={[
          { id: "seasonal-campaign-title", content: <ModuleWorkbench
          idPrefix="seasonal-campaign"
          eyebrow="CAMPAIGN SETUP"
          title="活動與需求窗口"
          headingId="seasonal-campaign-title"
          description="活動設定與需求登記是兩個不同任務；先建立並凍結適用範圍，再由授權窗口填寫需求。"
          tabs={[
            { id: "campaign", label: "活動設定", content: <SeasonalCampaignPanel /> },
            { id: "demand", label: "需求登記", content: <SeasonalDemandPanel /> },
          ]}
        /> },
          {
            id: "seasonal-approval-title",
            content: <>
              <div className="workspace-section-heading">
                <div><p className="eyebrow">CEO REVIEW</p><h2 id="seasonal-approval-title">換季送核</h2></div>
                <p>CEO 核准完整送核版本或退回並填寫理由；人資修正會建立新版本。</p>
              </div>
              <SeasonalApprovalPanel />
            </>,
          },
        ]}
      />
    </div>
  );
}
