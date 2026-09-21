import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("DEMO uniform cleanup SQL contract", () => {
  it("is transaction-scoped, exact-code-only, and fail-closed for business history", () => {
    const sql = fs.readFileSync(
      path.resolve("supabase/manual/remove-demo-uniform-items.sql"),
      "utf8",
    );

    for (const itemCode of [
      "DEMO-SHIRT-M",
      "DEMO-SHIRT-L",
      "DEMO-PANTS-M",
      "DEMO-PANTS-L",
    ]) {
      expect(sql).toContain(`'${itemCode}'`);
    }

    expect(sql).toContain("begin;");
    expect(sql).toContain("commit;");
    expect(sql).toContain("demo_fk_blockers");
    expect(sql).toContain("posting_row.posting_kind <> 'OPENING'");
    expect(sql).toContain("ledger_row.movement_kind <> 'OPENING_BALANCE'");
    expect(sql.toLowerCase()).not.toMatch(/delete\s+[^;]+\s+cascade/);
    expect(sql).not.toContain("like 'DEMO-%'");
  });
});
