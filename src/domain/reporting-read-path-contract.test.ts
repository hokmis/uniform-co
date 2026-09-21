import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(process.cwd(), "src/app/ReportingPanel.tsx"), "utf8");
const overviewSource = readFileSync(resolve(process.cwd(), "src/app/OverviewDashboard.tsx"), "utf8");
const overviewReadSource = readFileSync(resolve(process.cwd(), "src/lib/overview-dashboard-read.ts"), "utf8");
const identityGatedPanels = [
  "EmployeeImportPanel.tsx",
  "ErpExportPanel.tsx",
  "PdfArtifactPanel.tsx",
  "ProcurementReasonCodePanel.tsx",
  "SeasonalApprovalPanel.tsx",
  "SeasonalCampaignPanel.tsx",
  "SeasonalProcurementPanel.tsx",
].map((fileName) => ({ fileName, source: readFileSync(resolve(process.cwd(), "src/app", fileName), "utf8") }));

describe("reporting read path", () => {
  it("keeps the last complete report visible while switching or retrying", () => {
    const changeReport = source.slice(
      source.indexOf("function changeReport"),
      source.indexOf("function toggleSort", source.indexOf("function changeReport")),
    );
    expect(changeReport).not.toContain("setRows([])");
    expect(source).toContain("loadedReportName");
    expect(source).toContain("shouldPreserveReadSnapshot");
  });

  it("selects only the columns declared by the report catalog", () => {
    expect(source).toContain("select(reportColumns)");
    expect(source).toContain("retrySupabaseQueriesAfterSessionRefresh");
    expect(source).toContain("useWorkspaceSession");
    expect(source).toContain("identityReady");
    expect(source).not.toContain('select("*")');
    expect(source).toContain("if (!identityReady || !client)");
  });

  it("keeps report reads separate from mutation-style busy locking", () => {
    expect(source).toContain("const [dataLoading, setDataLoading] = useState(false);");
    expect(source).toContain("aria-busy={dataLoading}");
    expect(source).toContain("const visibleRows = useMemo(() => hasCurrentDataSnapshot ? rows : [], [hasCurrentDataSnapshot, rows]);");
    expect(source).toContain("dataSnapshotAccountIdRef.current === accountId");
    expect(source).toContain("loading={dataLoading && visibleRows.length === 0}");
    expect(source).not.toContain("disabled={dataLoading}");
    expect(source).toContain('onClick={() => setReloadToken((value) => value + 1)}>{dataLoading ? "讀取中…" : "重新整理"}');
    expect(source).not.toContain("const [busy, setBusy] = useState(false);");
    expect(source).not.toContain("disabled={busy}");
  });

  it("keeps dashboard activity and work queues in deterministic order", () => {
    expect(overviewReadSource).toContain('.order("created_at", { ascending: false })');
    expect(overviewReadSource).toContain('.order("remaining_to_accept", { ascending: false })');
    expect(overviewSource).toContain('.order("occurred_at", { ascending: false })');
    expect(overviewSource).toContain('.order("occurred_on", { ascending: false })');
  });

  it("keeps dashboard reads retryable and recoverable without a full page refresh", () => {
    expect(overviewSource).toContain("retrySupabaseQueriesAfterSessionRefresh");
    expect(overviewSource).toContain("loadOverviewCore");
    expect(overviewSource).toContain("dataSnapshotAccountIdRef.current === accountId");
    expect(overviewSource).toContain("const visibleData = hasCurrentDataSnapshot ? data : emptyData;");
    expect(overviewSource).toContain("shouldPreserveReadSnapshot");
    expect(overviewSource).toContain("staleReadSnapshotMessage");
    expect(overviewSource).toContain("[accountId, client, coreReadAhead, identityError, identityReady, panelActive, reloadRequest, sessionUserId]");
    expect(overviewReadSource).toContain("shouldProbeReadModel");
    expect(overviewReadSource).toContain("shouldUseLegacyReadModel");
    expect(overviewSource).toContain("useWorkspaceSession");
    expect(overviewSource).toContain("identityReady");
    expect(overviewSource).toContain('queueReload("all")');
    expect(overviewSource).toContain("重新整理總覽");
    expect(overviewSource).toContain('onClick={() => queueReload("all")} disabled={!identityReady}');
    expect(overviewSource).not.toContain('onClick={() => queueReload("all")} disabled={displayLoading}');
    expect(overviewSource).toContain("aria-busy={readPresentation.busy}");
    expect(overviewSource).toContain("readPresentation.coreRefreshing");
    expect(overviewSource).not.toContain("displayLoading || displayDeferredLoading");
    expect(overviewSource).toContain('value={readPresentation.showCorePlaceholder ? null : derived.hrProgress}');
    expect(overviewSource).toContain('value={readPresentation.showCorePlaceholder ? null : derived.receiptProgress}');
    expect(overviewSource).toContain('value={readPresentation.showCorePlaceholder ? null : derived.availabilityProgress}');
    expect(overviewSource).toContain('value === null ? "—" :');
    expect(overviewSource).not.toContain('supabase.from("v_item_availability")');
    expect(overviewSource).not.toContain('supabase.from("v_hr_request_item_totals")');
    expect(overviewSource).not.toContain('supabase.from("v_pending_warehouse_shipments")');
    expect(overviewSource).not.toContain('supabase.from("v_purchase_order_receipt_progress")');
  });

  it("starts a same-session overview read ahead of identity without exposing an unbound snapshot", () => {
    expect(overviewSource).toContain("createOverviewReadAheadCoordinator");
    expect(overviewSource).toContain("if (!client || !sessionUserId || !panelActive || !identityLoading || identityError) return;");
    expect(overviewSource).toContain("coreReadAhead.start(sessionUserId, () => loadOverviewCoreReadAhead(client, sessionUserId))");
    expect(overviewSource).toContain("coreReadAhead.take(sessionUserId)");
    expect(overviewSource).toContain("prefetchedCore?.authUserId === sessionUserId");
    expect(overviewSource).toContain("prefetchedCore.binding === \"auth-user\" || prefetchedCore.accountId === accountId");
    expect(overviewSource).toContain("const prefetchedCoreMatchesIdentity = Boolean(");
    expect(overviewSource).toContain("const visibleData = hasCurrentDataSnapshot ? data : emptyData;");
    expect(overviewSource).toContain("dataSnapshotAccountIdRef.current === accountId");
  });

  it("does not start protected workspace reads before identity is ready", () => {
    for (const { fileName, source: panelSource } of identityGatedPanels) {
      expect(panelSource, fileName).toContain("useWorkspaceSession");
      expect(panelSource, fileName).toContain("identityReady");
      expect(panelSource, fileName).toContain("!identityReady || !client");
    }
  });

  it("requires an explicit PDF source document", () => {
    const pdfSource = readFileSync(resolve(process.cwd(), "src/app/PdfArtifactPanel.tsx"), "utf8");
    expect(pdfSource).toContain('setDocumentId((current) => rows.some((row) => row.id === current) ? current : "")');
    expect(pdfSource).not.toContain("rows[0]?.id");
  });
});
