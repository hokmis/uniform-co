import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("DEMO cleanup with mixed stocktake contract", () => {
  it("removes only DEMO lines and keeps mixed postings", () => {
    const sql = fs.readFileSync(
      path.resolve("supabase/manual/remove-demo-uniform-items-preserve-real-stocktake.sql"),
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

    expect(sql).toContain("demo_postings_to_delete");
    expect(sql).toContain("delete from public.inventory_ledger_entries");
    expect(sql).toContain("and exists (select 1 from demo_target_items");
    expect(sql).toContain("delete from public.stocktake_lines");
    expect(sql).toContain("delete from public.replenishment_request_lines");
    expect(sql).toContain("disable trigger stocktake_lines_immutable_guard");
    expect(sql).toContain("enable trigger stocktake_lines_immutable_guard");
    expect(sql).toContain("demo_item_fk_blockers");
    expect(sql).toContain("system_cutover_state");
    expect(sql).toContain("No active SYSTEM_ADMIN account with Auth binding was found");
    expect(sql).toContain("order by account_row.created_at, account_row.id");
    expect(sql).toContain("request.jwt.claim.sub");
    expect(sql).toContain("private.current_account_id()");
    expect(sql.toLowerCase()).not.toMatch(/delete\s+[^;]+\s+cascade/);
  });
});
