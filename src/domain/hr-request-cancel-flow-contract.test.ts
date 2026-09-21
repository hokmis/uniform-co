import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = join(
  process.cwd(),
  "supabase",
  "migrations",
  "0093_hr_request_cancel_draft_shipment_cleanup.sql",
);

describe("HR cancellation workflow contract", () => {
  it("removes only unposted warehouse drafts when a request is cancelled or revised", async () => {
    const migration = await readFile(migrationPath, "utf8");

    expect(migration).toContain("cleanup_hr_request_draft_shipment_on_cancel");
    expect(migration).toContain("new.status = 'CANCELLED'");
    expect(migration).toContain("old.status in ('SUBMITTED', 'INVENTORY_REVIEW_REQUIRED') and new.status = 'DRAFT'");
    expect(migration).toContain("s.status = 'DRAFT'");
    expect(migration).toContain("delete from public.warehouse_shipment_lines");
    expect(migration).toContain("delete from public.warehouse_shipments");
    expect(migration).not.toContain("s.status = 'POSTED'");
  });
});
