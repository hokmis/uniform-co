import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(process.cwd(), "src/app/WorkspaceShell.tsx"), "utf8");
const workspaceTargets = {
  OverviewWorkspace: ["OrganizationManagementPanel", "ProductManagementPanel", "DurableImportPanel"],
  AccountWorkspace: [],
  HrWorkspace: ["HrRequestHistoryPanel", "ReplenishmentPanel", "ReturnPanel", "HrIssueCorrectionPanel", "ReturnCorrectionPanel", "EmployeeManagementPanel"],
  WarehouseWorkspace: ["WarehouseShipmentPanel", "StocktakePanel", "WarehouseTransferCorrectionPanel", "StocktakeCorrectionPanel"],
  ProcurementWorkspace: ["ProcurementReasonCodePanel", "PurchaseReceiptCorrectionPanel", "PurchaseReceiptPanel"],
  ReportsWorkspace: ["PdfArtifactPanel", "ErpExportPanel"],
  SeasonalWorkspace: ["SeasonalDemandPanel", "SeasonalApprovalPanel"],
} as const;

const workspaceSources = Object.entries(workspaceTargets).map(([name, targets]) => ({
  name,
  source: readFileSync(resolve(process.cwd(), `src/app/workspaces/${name}.tsx`), "utf8"),
  targets,
}));
const secondaryWorkspaceSources = workspaceSources.filter(({ name }) => name !== "AccountWorkspace");

describe("workspace loading seam", () => {
  it("loads each workspace through a dynamic seam instead of bundling every panel into the shell", () => {
    expect(source).toContain('import dynamic from "next/dynamic"');
    expect(source).toContain("const workspaceLoaders = {");
    for (const workspace of ["OverviewWorkspace", "AccountWorkspace", "HrWorkspace", "WarehouseWorkspace", "ProcurementWorkspace", "SeasonalWorkspace", "ReportsWorkspace"]) {
      expect(source).toContain(`workspaceLoaders.${workspace === "AccountWorkspace" ? "accounts" : workspace.replace("Workspace", "").toLocaleLowerCase()}`);
    }
    expect(source).not.toContain('import OverviewWorkspace from "./workspaces/OverviewWorkspace"');
    expect(source).not.toContain('import ReportsWorkspace from "./workspaces/ReportsWorkspace"');
  });

  it("waits for deliberate hover or focus intent and starts immediately on navigation", () => {
    expect(source).toContain("function prefetchWorkspace");
    expect(source).toContain("prefetchedWorkspaceIds");
    expect(source).toContain("useMemo(() => createWorkspacePrefetchIntent(prefetchWorkspace), [])");
    expect(source).toContain("onPointerEnter={() => workspacePrefetchIntent.schedule(workspace.id)}");
    expect(source).toContain("onPointerLeave={() => workspacePrefetchIntent.cancel(workspace.id)}");
    expect(source).toContain("onFocus={() => workspacePrefetchIntent.schedule(workspace.id)}");
    expect(source).toContain("onBlur={() => workspacePrefetchIntent.cancel(workspace.id)}");
    expect(source).toContain("prefetchWorkspace(id);");
    expect(source).toContain("workspacePrefetchIntent.cancelAll()");
    expect(source).not.toContain("workspaceDefinitions.forEach");
  });

  it("keeps an immediate accessible loading shell while a workspace chunk is fetched", () => {
    expect(source).toContain('import WorkspacePanelLoading from "./WorkspacePanelLoading"');
    expect(source).toContain('loading: () => <WorkspacePanelLoading label="正在載入總覽" />');
    expect(source).not.toContain("function WorkspaceLoading");
    expect(source).not.toContain("其他工作區不會同時載入");
  });

  it("keeps secondary workspace modules behind their own lazy seam", () => {
    for (const { name, source: workspaceSource, targets } of secondaryWorkspaceSources) {
      expect(workspaceSource, name).toContain('import dynamic from "next/dynamic"');
      for (const target of targets) {
        expect(workspaceSource, `${name}/${target}`).toContain(`dynamic(() => import("../${target}")`);
        expect(workspaceSource, `${name}/${target}`).not.toContain(`import ${target} from "../${target}"`);
      }
    }
  });

  it("keeps retained panel elements and navigation callbacks stable across unrelated renders", () => {
    expect(source).toContain("const activeWorkspaceRef = useRef(activeWorkspace);");
    expect(source).toContain("const selectWorkspace = useCallback(");
    expect(source).toContain("const workspaceChanged = activeWorkspaceRef.current !== id;");
    expect(source).toContain("current[id] === nextModule ? current");
    expect(source).toContain("const MemoizedWorkspaceContent = memo(WorkspaceContent);");
    expect(source).toContain("content: <MemoizedWorkspaceContent");
    expect(source).toContain("panels={workspacePanels}");

    for (const { name, source: workspaceSource } of workspaceSources) {
      expect(workspaceSource, name).toContain("const panels = useMemo(");
      expect(workspaceSource, name).toContain("panels={panels}");
      expect(workspaceSource, name).not.toMatch(/panels=\{\s*\[/);
    }
  });
});
