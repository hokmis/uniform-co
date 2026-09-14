import AccountAdminPanel from "../AccountAdminPanel";
import RetainedPanelSet from "../RetainedPanelSet";

type Props = { activeModule: string };

export default function AccountWorkspace({ activeModule }: Props) {
  return (
    <div className="workspace-sections">
      <RetainedPanelSet
        idPrefix="workspace-module"
        activePanelId={activeModule}
        panelClassName="workspace-section"
        panels={[{ id: "accounts-admin-title", content: <AccountAdminPanel headingId="accounts-admin-title" /> }]}
      />
    </div>
  );
}
