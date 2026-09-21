import WorkspaceShell from "../WorkspaceShell";
import { requireServerAuthUser } from "../../server/target-session";

export const dynamic = "force-dynamic";

export default async function AppPage() {
  await requireServerAuthUser();
  return (
    <main className="shell">
      <WorkspaceShell />
    </main>
  );
}
