import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(resolve(process.cwd(), "src/app/ProcurementReasonCodePanel.tsx"), "utf8");

describe("procurement reason read path", () => {
  it("keeps reason-code reads account-bound without locking an existing list", () => {
    expect(source).toContain("dataSnapshotAccountIdRef.current === accountId");
    expect(source).toContain("const visibleReasons = useMemo(() => hasCurrentDataSnapshot ? reasons : [], [hasCurrentDataSnapshot, reasons]);");
    expect(source).toContain("createReadRequestController");
    expect(source).toContain("shouldPreserveReadSnapshot");
    expect(source).toContain("staleReadSnapshotMessage");
    expect(source).toContain("loading={dataLoading && visibleReasons.length === 0}");
    expect(source).toContain("if (active && readController.isCurrent(readSequence)) setDataLoading(false)");
    expect(source).toContain("[accountId, client, identityError, identityReady, panelActive, reloadToken]");
  });
});
