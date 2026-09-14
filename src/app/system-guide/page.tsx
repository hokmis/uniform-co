import type { Metadata } from "next";
import WorkspaceShell from "../WorkspaceShell";

export const metadata: Metadata = {
  title: "System Guide｜制服管理系統",
  description: "制服管理系統的使用者、管理者與 AI Agent 說明",
};

export default function SystemGuidePage() {
  return <WorkspaceShell initialSystemGuide />;
}
