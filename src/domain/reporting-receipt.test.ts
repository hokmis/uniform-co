import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../supabase/migrations/0064_reporting_receipt_aggregation.sql", import.meta.url),
  "utf8",
);

describe("receipt progress reporting forward fix", () => {
  it("aggregates corrections by PO line before joining receipt totals", () => {
    expect(migration).toContain("correction_totals_by_po_line");
    expect(migration).toContain("group by source_line.purchase_order_line_id");
    expect(migration).toContain("left join correction_totals_by_po_line ct");
    expect(migration).not.toContain("left join public.purchase_receipt_lines source_line");
  });
});
