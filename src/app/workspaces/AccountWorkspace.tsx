import AccountAdminPanel from "../AccountAdminPanel";
import { useMemo } from "react";
import RetainedPanelSet from "../RetainedPanelSet";

type Props = { activeModule: string };

export default function AccountWorkspace({ activeModule }: Props) {
  const panels = useMemo(() => [{ id: "accounts-admin-title", content: <AccountAdminPanel headingId="accounts-admin-title" /> }], []);

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
