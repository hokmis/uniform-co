import { describe, expect, it } from "vitest";
import {
  ALL_CORRECTION_HISTORY_STATUSES,
  correctionHistoryStatuses,
  filterCorrectionHistory,
  sortCorrectionHistory,
  type CorrectionHistoryRow,
} from "./correction-history";

const rows: CorrectionHistoryRow[] = [
  { id: "2", correctionNo: "RTC-002", status: "POSTED", reason: "退回數量誤登", deltaText: "-2", postedAt: "2026-08-30T10:00:00Z" },
  { id: "1", correctionNo: "RTC-001", status: "DRAFT", reason: "待主管確認", deltaText: "3", postedAt: null },
  { id: "3", correctionNo: "RTC-003", status: "CANCELLED", reason: "重複建立", deltaText: "1", postedAt: null },
];

describe("correction history", () => {
  it("returns status options in the workflow order and keeps unknown statuses usable", () => {
    expect(correctionHistoryStatuses(rows)).toEqual(["DRAFT", "POSTED", "CANCELLED"]);
  });

  it("filters correction number, translated status and reason without mutating source rows", () => {
    expect(filterCorrectionHistory(rows, "已過帳", ALL_CORRECTION_HISTORY_STATUSES).map((row) => row.id)).toEqual(["2"]);
    expect(filterCorrectionHistory(rows, "數量", "POSTED").map((row) => row.correctionNo)).toEqual(["RTC-002"]);
    expect(rows.map((row) => row.id)).toEqual(["2", "1", "3"]);
  });

  it("filters by an explicit status", () => {
    expect(filterCorrectionHistory(rows, "", "DRAFT").map((row) => row.correctionNo)).toEqual(["RTC-001"]);
  });

  it("sorts a copy and uses the correction number as a deterministic tie breaker", () => {
    expect(sortCorrectionHistory(rows, "correction_no", "asc").map((row) => row.correctionNo)).toEqual(["RTC-001", "RTC-002", "RTC-003"]);
    expect(sortCorrectionHistory(rows, "status", "asc").map((row) => row.status)).toEqual(["DRAFT", "POSTED", "CANCELLED"]);
    expect(rows.map((row) => row.correctionNo)).toEqual(["RTC-002", "RTC-001", "RTC-003"]);
  });
});
