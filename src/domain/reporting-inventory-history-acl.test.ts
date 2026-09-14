import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../supabase/migrations/0066_inventory_history_source_acl.sql", import.meta.url),
  "utf8",
);

describe("inventory history source-map ACL", () => {
  it("allows only inventory readers to resolve source numbers", () => {
    expect(migration).toContain("alter table public.opening_posting_sources enable row level security");
    expect(migration).toContain("opening_posting_sources_inventory_history_read");
    expect(migration).toContain("correction_posting_sources_inventory_history_read");
    expect(migration).toContain("private.has_role('HR') or private.has_role('WAREHOUSE')");
    expect(migration).toContain("grant select on public.opening_posting_sources, public.correction_posting_sources to authenticated");
  });
});
