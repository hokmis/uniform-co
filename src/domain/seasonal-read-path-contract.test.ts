import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const panelFiles = [
  "SeasonalCampaignPanel.tsx",
  "SeasonalDemandPanel.tsx",
  "SeasonalApprovalPanel.tsx",
  "SeasonalProcurementPanel.tsx",
] as const;

describe("seasonal workspace read recovery", () => {
  it("keeps seasonal reads retryable and recoverable inside each panel", () => {
    for (const fileName of panelFiles) {
      const source = readFileSync(resolve(process.cwd(), "src/app", fileName), "utf8");
      expect(source, fileName).toContain("reloadToken");
      expect(source, fileName).toContain("重新載入");
      expect(
        source.includes("retrySupabaseQueriesAfterSessionRefresh")
          || source.includes("loadActiveEmployeeOptions"),
        fileName,
      ).toBe(true);
      if (fileName === "SeasonalCampaignPanel.tsx") {
        expect(source).toContain("useWorkspaceSession");
        expect(source).toContain("identityReady");
        expect(source).toContain("const optionsLoadSequence = useRef(0);");
        expect(source).toContain("const optionsInitialized = useRef(false);");
        expect(source).toContain("sequence === optionsLoadSequence.current");
        expect(source).toContain("optionsInitialized.current ? current.filter");
      }
    }
  });

  it("does not recreate a second global refresh mechanism", () => {
    for (const fileName of panelFiles) {
      const source = readFileSync(resolve(process.cwd(), "src/app", fileName), "utf8");
      expect(source, fileName).not.toContain("auth.refreshSession");
    }
  });

  it("loads the seasonal procurement queue through one server-shaped read seam", () => {
    const source = readFileSync(resolve(process.cwd(), "src/app/SeasonalProcurementPanel.tsx"), "utf8");
    expect(source).toContain('from("v_seasonal_procurement_queue")');
    expect(source).not.toContain('from("seasonal_approval_lines")');
    expect(source).not.toContain('from("seasonal_procurement_lines")');
    const migration = readFileSync(resolve(process.cwd(), "supabase/migrations/0109_seasonal_procurement_queue_view.sql"), "utf8");
    expect(migration).toContain("security_invoker = true");
    expect(migration).toContain("left join public.seasonal_procurement_lines");
    expect(migration).toContain("grant select on public.v_seasonal_procurement_queue to authenticated");
  });

  it("loads the seasonal demand workspace through one tagged read seam", () => {
    const source = readFileSync(resolve(process.cwd(), "src/app/SeasonalDemandPanel.tsx"), "utf8");
    expect(source).toContain('from("v_seasonal_demand_workspace")');
    expect(source).not.toContain('from("seasonal_campaign_employees")');
    expect(source).not.toContain('from("seasonal_campaign_items")');
    expect(source).not.toContain('from("seasonal_demand_lines")');
    const migration = readFileSync(resolve(process.cwd(), "supabase/migrations/0110_seasonal_demand_workspace_view.sql"), "utf8");
    expect(migration).toContain("security_invoker = true");
    expect(migration).toContain("union all");
    expect(migration).toContain("grant select on public.v_seasonal_demand_workspace to authenticated");
  });

  it("loads the seasonal approval queue through one server-shaped read seam", () => {
    const source = readFileSync(resolve(process.cwd(), "src/app/SeasonalApprovalPanel.tsx"), "utf8");
    expect(source).toContain('from("v_seasonal_approval_queue")');
    expect(source).not.toContain('from("seasonal_approval_submissions")');
    expect(source).not.toContain('from("seasonal_campaigns")');
    expect(source).toContain('const submissionIdRef = useRef("")');
    expect(source).toContain("const selectedSubmissionStillExists = loaded.some((submission) => submission.id === submissionIdRef.current);");
    expect(source).toContain("if (!selectedSubmissionStillExists)");
    expect(source).toContain("const visibleSubmissions = useMemo(() => hasCurrentDataSnapshot ? submissions : [], [hasCurrentDataSnapshot, submissions]);");
    expect(source).toContain("dataSnapshotAccountIdRef.current === accountId");
    expect(source).not.toContain("loaded[0]?.id ?? \"\"");
    const migration = readFileSync(resolve(process.cwd(), "supabase/migrations/0111_seasonal_approval_queue_view.sql"), "utf8");
    expect(migration).toContain("security_invoker = true");
    expect(migration).toContain("where submission.status = 'PENDING'");
    expect(migration).toContain("grant select on public.v_seasonal_approval_queue to authenticated");
  });

  it("does not auto-select the first procurement line or retain a stale editor", () => {
    const source = readFileSync(resolve(process.cwd(), "src/app/SeasonalProcurementPanel.tsx"), "utf8");
    expect(source).toContain("const selected = nextLines.find((line) => line.id === currentLineId);");
    expect(source).toContain("const currentLineId = lineIdRef.current;");
    expect(source).toContain("const currentSupplierId = supplierIdRef.current;");
    expect(source).toContain("const dataSnapshotAccountIdRef = useRef<string | null>(null);");
    expect(source).toContain("const dataReadBlocked = !hasCurrentDataSnapshot;");
    expect(source).toContain("const previousSnapshotAccountId = dataSnapshotAccountIdRef.current;");
    expect(source).toContain("const sameAccountSnapshot = previousSnapshotAccountId === accountId;");
    expect(source).toContain("const preserveCurrentEditor = currentLineId === selected.id");
    expect(source).toContain("&& sameAccountSnapshot");
    expect(source).toContain('setMessage("已同步採購資料，保留目前編輯內容")');
    expect(source).toContain('setLineId("");');
    expect(source).not.toContain("?? nextLines[0]");
  });

  it("fences overlapping procurement reads and loading state", () => {
    const source = readFileSync(resolve(process.cwd(), "src/app/SeasonalProcurementPanel.tsx"), "utf8");
    expect(source).toContain("createReadRequestController");
    expect(source).toContain("const readControllerRef = useRef<ReadRequestController | null>(null);");
    expect(source).toContain("const readSequence = readController.begin();");
    expect(source).toContain("if (!active || !readController.isCurrent(readSequence)) return;");
    expect(source).toContain("if (active && readController.isCurrent(readSequence)) setDataLoading(false);");
    expect(source).toContain("readControllerRef.current?.invalidate();");
  });

  it("fences approval queue and detail reads independently", () => {
    const source = readFileSync(resolve(process.cwd(), "src/app/SeasonalApprovalPanel.tsx"), "utf8");
    expect(source).toContain("const queueReadControllerRef = useRef<ReadRequestController | null>(null);");
    expect(source).toContain("const detailReadControllerRef = useRef<ReadRequestController | null>(null);");
    expect(source).toContain("if (!active || !readController.isCurrent(readSequence)) return;");
    expect(source).toContain("queueReadControllerRef.current?.invalidate();");
    expect(source).toContain("detailReadControllerRef.current?.invalidate();");
    expect(source).toContain("onClick={reloadApprovalData} disabled={busy}");
  });

  it("keeps seasonal refresh available while reads are in flight", () => {
    const sources = [
      ["SeasonalCampaignPanel.tsx", "reloadCampaignOptions"],
      ["SeasonalDemandPanel.tsx", "reloadDemandData"],
      ["SeasonalApprovalPanel.tsx", "reloadApprovalData"],
      ["SeasonalProcurementPanel.tsx", "reloadProcurementData"],
    ] as const;
    for (const [fileName, handler] of sources) {
      const source = readFileSync(resolve(process.cwd(), "src/app", fileName), "utf8");
      expect(source, fileName).toContain(`onClick={${handler}} disabled={busy}`);
      expect(source, fileName).not.toContain(`onClick={${handler}} disabled={busy || dataLoading}`);
    }
  });

  it("does not auto-select the first seasonal campaign, employee, or item", () => {
    const source = readFileSync(resolve(process.cwd(), "src/app/SeasonalDemandPanel.tsx"), "utf8");
    expect(source).toContain('setCampaignId((current) => loadedCampaigns.some((campaign) => campaign.id === current) ? current : "")');
    expect(source).toContain('setEmployeeId((current) => employeeRows.some((row) => row.employee_id === current) ? current : "")');
    expect(source).toContain('setItemId((current) => itemRows.some((row) => row.item_id === current) ? current : "")');
    expect(source).not.toContain("loadedCampaigns[0]?.id");
    expect(source).not.toContain("employeeRows[0]?.employee_id");
    expect(source).not.toContain("itemRows[0]?.item_id");
  });

  it("separates seasonal data loading from mutation busy state", () => {
    const campaignSource = readFileSync(resolve(process.cwd(), "src/app/SeasonalCampaignPanel.tsx"), "utf8");
    expect(campaignSource).toContain("const [dataLoading, setDataLoading] = useState(false);");
    expect(campaignSource).toContain("setDataLoading(true)");
    expect(campaignSource).toContain("onClick={reloadCampaignOptions} disabled={busy}");
    expect(campaignSource).toContain("aria-busy={dataLoading}");
    expect(campaignSource).toContain("const [optionsSnapshotReady, setOptionsSnapshotReady] = useState(false);");
    expect(campaignSource).toContain("const optionsReadBlocked = !hasCurrentOptionsSnapshot;");
    expect(campaignSource).toContain('staleReadSnapshotMessage("換季活動選項")');
    expect(campaignSource).toContain("disabled={busy || optionsReadBlocked || scopeReady}");
    expect(campaignSource).toContain("disabled={busy || !identityReady || !scopeReady}");
    expect(campaignSource).not.toContain("disabled={busy || dataLoading || !identityReady || !scopeReady}");
    for (const fileName of ["SeasonalApprovalPanel.tsx", "SeasonalProcurementPanel.tsx"] as const) {
      const source = readFileSync(resolve(process.cwd(), "src/app", fileName), "utf8");
      expect(source, fileName).toContain("const [dataLoading, setDataLoading] = useState(false);");
      expect(source, fileName).toContain("shouldPreserveReadSnapshot");
      expect(source, fileName).toContain("staleReadSnapshotMessage");
      expect(source, fileName).toContain(fileName === "SeasonalApprovalPanel.tsx"
        ? "loading={dataLoading && visibleSubmissions.length === 0}"
        : "loading={dataLoading && visibleLines.length === 0}");
      expect(source, fileName).toContain("disabled={busy}");
    }
    const demandSource = readFileSync(resolve(process.cwd(), "src/app/SeasonalDemandPanel.tsx"), "utf8");
    expect(demandSource).toContain("const dataLoading = campaignLoading || scopeLoading;");
    expect(demandSource).toContain("setCampaignLoading(true)");
    expect(demandSource).toContain("setScopeLoading(true)");
    expect(demandSource).toContain("const scopeLoadSequence = useRef(0);");
    expect(demandSource).toContain("scopeLoadSequence.current += 1;");
    expect(demandSource).toContain("sequence === scopeLoadSequence.current");
    expect(demandSource).toContain("loading={dataLoading}");
    expect(demandSource).toContain("const campaignReadBlocked = !hasCurrentCampaignSnapshot;");
    expect(demandSource).toContain("const scopeReadBlocked = !hasCurrentScopeSnapshot;");
    expect(demandSource).toContain("staleReadSnapshotMessage(\"活動範圍與既有需求\")");
    expect(demandSource).toContain("disabled={busy || campaignReadBlocked}");
    expect(demandSource).toContain("disabled={busy || scopeReadBlocked}");
    expect(demandSource).toContain("disabled={busy}");
    expect(demandSource).toContain("disabled={busy || scopeReadBlocked || !campaignId || !employeeId || !itemId}");
    expect(demandSource).not.toContain("disabled={busy || dataLoading} />");
  });
});
