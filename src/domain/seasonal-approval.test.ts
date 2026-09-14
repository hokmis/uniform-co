import { describe, expect, it } from "vitest";
import { filterSeasonalApprovalQueue, sortSeasonalApprovalQueue, type SeasonalApprovalQueueRow } from "./seasonal-approval";

const rows: SeasonalApprovalQueueRow[] = [
  { id: "2", campaignNo: "SEA-002", campaignName: "冬季換季", revision: 2, demandSnapshotHash: "hash-two", submittedAt: "2026-08-30T10:00:00Z" },
  { id: "1", campaignNo: "SEA-001", campaignName: "夏季換季", revision: 12, demandSnapshotHash: "hash-one", submittedAt: "2026-08-29T10:00:00Z" },
];

describe("seasonal approval queue", () => {
  it("filters campaign identity, revision and snapshot hash without mutating source rows", () => {
    expect(filterSeasonalApprovalQueue(rows, "冬季").map((row) => row.id)).toEqual(["2"]);
    expect(filterSeasonalApprovalQueue(rows, "12").map((row) => row.id)).toEqual(["1"]);
    expect(filterSeasonalApprovalQueue(rows, "hash-one").map((row) => row.id)).toEqual(["1"]);
    expect(rows.map((row) => row.id)).toEqual(["2", "1"]);
  });

  it("sorts revision as a number and keeps the source order unchanged", () => {
    expect(sortSeasonalApprovalQueue(rows, "revision", "asc").map((row) => row.revision)).toEqual([2, 12]);
    expect(sortSeasonalApprovalQueue(rows, "revision", "desc").map((row) => row.revision)).toEqual([12, 2]);
    expect(rows.map((row) => row.revision)).toEqual([2, 12]);
  });

  it("sorts submission time and campaign name deterministically", () => {
    expect(sortSeasonalApprovalQueue(rows, "submitted_at", "asc").map((row) => row.id)).toEqual(["1", "2"]);
    expect(sortSeasonalApprovalQueue(rows, "campaign_name", "asc").map((row) => row.id)).toEqual(["2", "1"]);
  });
});
