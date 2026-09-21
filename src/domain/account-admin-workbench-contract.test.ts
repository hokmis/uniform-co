import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(process.cwd(), "src", "app", "AccountAdminPanel.tsx"), "utf8");
const directoryMigration = readFileSync(resolve(process.cwd(), "supabase", "migrations", "0121_account_directory_view.sql"), "utf8");

describe("account admin workbench mount contract", () => {
  it("mounts account tabs through the retained panel seam", () => {
    expect(source).toContain("RetainedPanelSet");
    expect(source).toContain('activePanelId={activeTab}');
    expect(source).toContain('{ id: "directory", content:');
    expect(source).toContain('{ id: "create", content:');
    expect(source).toContain('{ id: "manage", content:');
  });

  it("does not keep all account tabs mounted with hidden DOM", () => {
    expect(source).not.toContain('hidden={activeTab !== "directory"}');
    expect(source).not.toContain('hidden={activeTab !== "create"}');
    expect(source).not.toContain('hidden={activeTab !== "manage"}');
  });

  it("defers organization and coordinator-scope reads until account settings is opened", () => {
    expect(source).toContain("useWorkspaceSession");
    expect(source).toContain("identityReady");
    expect(source).toContain("if (!identityReady || !client) return null;");
    expect(source).toContain("const fetchDirectoryData");
    expect(source).toContain("const fetchScopeRows");
    expect(source).toContain("const fetchManageOptions");
    expect(source).toContain("void loadManageData(account.id)");
    expect(source).toContain("if (nextTab === \"manage\" && selectedId) void loadManageData(selectedId)");

    const scopeRead = source.slice(source.indexOf("const fetchScopeRows"), source.indexOf("const fetchManageOptions"));
    const optionsRead = source.slice(source.indexOf("const fetchManageOptions"), source.indexOf("const applyDirectoryData"));
    expect(scopeRead).toContain('.from("coordinator_scopes").select("account_id,institution_id,department_id").eq("account_id", accountId)');
    expect(scopeRead).not.toContain("loadOrganizationMasterData");
    expect(optionsRead).toContain("loadOrganizationMasterData");
    expect(optionsRead).not.toContain('from("coordinator_scopes")');

    const directoryRead = source.slice(
      source.indexOf("const fetchDirectoryData"),
      source.indexOf("const fetchScopeRows"),
    );
    expect(directoryRead).not.toContain("coordinator_scopes");
    expect(directoryRead).not.toContain("loadOrganizationMasterData");
  });

  it("uses the aggregated account directory read seam", () => {
    expect(source).toContain("loadAccountDirectory");
    const directoryRead = source.slice(
      source.indexOf("const fetchDirectoryData"),
      source.indexOf("const fetchManageData"),
    );
    expect(directoryRead).not.toContain('from("app_accounts")');
    expect(directoryRead).not.toContain('from("user_roles")');
    expect(directoryMigration).toContain("security_invoker = true");
    expect(directoryMigration).toContain("v_account_directory");
    expect(directoryMigration).toContain("grant select on public.v_account_directory to authenticated");
  });

  it("does not expose a previous administrator's directory while identity refreshes", () => {
    expect(source).toContain("const [directorySnapshotAccountId, setDirectorySnapshotAccountId] = useState<string | null>(null);");
    expect(source).toContain("const directorySnapshotAccountIdRef = useRef<string | null>(null);");
    expect(source).toContain("const hasCurrentDirectorySnapshot = Boolean(");
    expect(source).toContain("const visibleAccounts = useMemo(() => hasCurrentDirectorySnapshot ? accounts : [], [accounts, hasCurrentDirectorySnapshot]);");
    expect(source).toContain("directorySnapshotAccountIdRef.current = workspaceAccountId;");
    expect(source).toContain("clearDirectorySnapshot();");
    expect(source).toContain("badge: String(visibleAccounts.length)");
  });

  it("does not let low-frequency scope reads block unrelated account operations", () => {
    expect(source).toContain("<input value={reason}");
    expect(source).toContain("<input value={newAuthUserId}");
    expect(source).toContain("<input value={recoveryTicket}");
    expect(source).toContain("<select value={unbindAuth ? \"UNBIND\" : \"REBIND\"}");
    expect(source).toContain("onClick={() => void setStatus()} disabled={busy || !reason.trim()}");
    expect(source).toContain("onClick={() => void rebindAuth()} disabled={busy || !reason.trim() || (!unbindAuth && !newAuthUserId.trim())}");
    expect(source).not.toContain("onClick={() => void setStatus()} disabled={busy || manageDataLoading");
    expect(source).not.toContain("onClick={() => void rebindAuth()} disabled={busy || manageDataLoading");
    expect(source).not.toContain("onClick={() => setDeleteConfirming(true)} disabled={busy || manageDataLoading");
    expect(source).toContain("const manageOptionsReady = institutions.length > 0 || departments.length > 0;");
    expect(source).toContain("const [scopeDataLoading, setScopeDataLoading] = useState(false);");
    expect(source).toContain("const [organizationOptionsLoading, setOrganizationOptionsLoading] = useState(false);");
    expect(source).toContain("const scopeActionLabel = busy");
    expect(source).toContain("disabled={busy || !manageOptionsReady}");
    expect(source).toContain("disabled={busy || scopeDataLoading || !manageOptionsReady || !institutionId || !departmentId}");
    expect(source).not.toContain("manageDataLoading");
    expect(source).toContain("setInstitutionId(\"\");");
    expect(source).toContain("setScopeRows([]);");
  });

  it("does not use mutation busy to lock the account workbench during directory refresh", () => {
    const refreshSource = source.slice(
      source.indexOf("async function refreshAccounts"),
      source.indexOf("useEffect", source.indexOf("async function refreshAccounts")),
    );
    expect(refreshSource).toContain("const data = await loadDirectory()");
    expect(refreshSource).not.toContain("setBusy(true)");
    expect(source).toContain("disabled={busy}");
    expect(source).not.toContain("disabled={busy || directoryLoading}");
    expect(source).not.toContain("if (busy || directoryLoading) return;");
    expect(source).toContain("const directoryLoadSequence = useRef(0);");
    expect(source).toContain("if (sequence !== directoryLoadSequence.current) return null;");
    expect(source).toContain("if (sequence === directoryLoadSequence.current) setDirectoryLoading(false);");
    expect(source).toContain("const manageLoadSequence = useRef(0);");
    expect(source).toContain("if (sequence === manageLoadSequence.current) applyManageData(data);");
    expect(source).toContain("if (sequence === manageLoadSequence.current) applyManageOptions(data);");
    expect(source).toContain("if (sequence === manageLoadSequence.current) setScopeDataLoading(false);");
    expect(source).toContain("if (sequence === manageLoadSequence.current) setOrganizationOptionsLoading(false);");
  });
});
