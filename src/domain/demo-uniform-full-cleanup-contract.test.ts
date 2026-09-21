import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("DEMO full cleanup SQL contract", () => {
  it("limits destructive cleanup to the confirmed documents and restores guards", () => {
    const sql = fs.readFileSync(
      path.resolve("supabase/manual/remove-demo-uniform-items-with-test-documents.sql"),
      "utf8",
    );

    for (const value of [
      "DEMO-SHIRT-M",
      "DEMO-SHIRT-L",
      "DEMO-PANTS-M",
      "DEMO-PANTS-L",
      "REP-20260918071402",
      "MANUAL-ADD-100-20260918-002",
      "MANUAL-ADD-50-20260918-001",
    ]) {
      expect(sql).toContain(`'${value}'`);
    }

    expect(sql).toContain("begin;");
    expect(sql).toContain("commit;");
    expect(sql).toContain("disable trigger replenishment_requests_immutable_guard");
    expect(sql).toContain("enable trigger replenishment_requests_immutable_guard");
    expect(sql).toContain("disable trigger stocktakes_immutable_guard");
    expect(sql).toContain("enable trigger stocktakes_immutable_guard");
    expect(sql).toContain("demo_posting_fk_blockers");
    expect(sql).toContain("system_cutover_state");
    expect(sql.toLowerCase()).not.toMatch(/delete\s+[^;]+\s+cascade/);
    expect(sql).not.toContain("like 'DEMO-%'");
  });
});
