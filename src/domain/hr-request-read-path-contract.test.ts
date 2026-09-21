import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(
  resolve(process.cwd(), "src/app/HrRequestWorkbench.tsx"),
  "utf8",
);
const historySource = readFileSync(
  resolve(process.cwd(), "src/app/HrRequestHistoryPanel.tsx"),
  "utf8",
);
const historyMigration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0099_hr_request_history_view.sql"),
  "utf8",
);
const optionMigration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/0104_hr_request_option_views.sql"),
  "utf8",
);

describe("HR request read path", () => {
  it("uses the authoritative availability view instead of duplicating inventory aggregation in the browser", () => {
    expect(source).toContain("loadHrRequestMasterData");
    expect(source).toContain("buildActiveHrEmployeeOptions");
    expect(source).toContain("preserveHrRequestDraftLines");
    expect(source).toContain("preserveHrRequestIncreaseDraft");
    expect(optionMigration).toContain("v_hr_request_employee_options");
    expect(optionMigration).toContain("v_hr_request_item_options");
    expect(optionMigration).toContain("from public.v_item_availability");
    expect(optionMigration).toContain("security_invoker = true");
  });

  it("loads the history summary from one RLS-backed view", () => {
    const initialLoader = historySource.slice(
      historySource.indexOf("async function loadRows"),
      historySource.indexOf("async function loadDetail"),
    );
    expect(initialLoader).toContain('from("v_hr_request_history")');
    expect(initialLoader).not.toContain('from("warehouse_shipments")');
    expect(initialLoader).not.toContain('from("inventory_reservations")');
    expect(historyMigration).toContain("security_invoker = true");
    expect(historyMigration).toContain("grant select on public.v_hr_request_history to authenticated");
    expect(historyMigration).toContain("hr_requests_created_at_idx");
    expect(historyMigration).toContain("inventory_reservations_source_status_idx");
  });

  it("loads selected request details through one tagged read seam", () => {
    const detailLoader = historySource.slice(
      historySource.indexOf("async function loadDetail"),
      historySource.indexOf("useEffect(() =>", historySource.indexOf("async function loadDetail")),
    );
    expect(detailLoader).toContain('from("v_hr_request_history_detail")');
    expect(detailLoader).not.toContain('from("hr_request_items")');
    expect(detailLoader).not.toContain('from("hr_issue_lines")');
    expect(detailLoader).not.toContain('from("inventory_reservations")');
    const migration = readFileSync(resolve(process.cwd(), "supabase/migrations/0112_hr_request_history_detail_view.sql"), "utf8");
    expect(migration).toContain("security_invoker = true");
    expect(migration).toContain("union all");
    expect(migration).toContain("grant select on public.v_hr_request_history_detail to authenticated");
    expect(historySource).toContain("historyReadSequenceRef");
    expect(historySource).toContain("detailReadSequenceRef");
    expect(historySource).toContain("detailLoadedForRequestId");
    expect(historySource).toContain("shouldPreserveReadSnapshot");
    expect(historySource).toContain("const visibleRows = useMemo(() => hasCurrentDataSnapshot ? rows : [], [hasCurrentDataSnapshot, rows]);");
    expect(historySource).toContain("dataSnapshotAccountIdRef.current === accountId");
    expect(historySource).toContain("const resolvedSelectedId = loaded.some((row) => row.id === nextSelectedId) ? nextSelectedId : \"\";");
    expect(historySource).not.toContain("loaded[0]?.id ?? \"\"");
    expect(historySource).toContain('onClick={() => void loadRows()}>{loading ? "讀取中…" : "重新整理"}');
    expect(historySource).not.toContain('onClick={() => void loadRows()} disabled={loading}');
  });
});
