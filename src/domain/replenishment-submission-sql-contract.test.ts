import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase", "migrations", "0130_atomic_replenishment_submission.sql"),
  "utf8",
);

describe("atomic replenishment submission SQL contract", () => {
  it("requires and delegates to the existing draft and submit RPCs", () => {
    expect(migration).toContain("public.create_replenishment_draft(");
    expect(migration).toContain("public.update_replenishment_request_draft(");
    expect(migration).toContain("public.submit_replenishment_request(");
    expect(migration).toContain("submitted_row := public.submit_replenishment_request(");
    expect(migration).not.toMatch(/insert\s+into\s+public\.(inventory_balances|inventory_ledger_entries)/i);
  });

  it("keeps the wrapper HR-only, transaction-safe and non-public", () => {
    expect(migration).toContain("security definer");
    expect(migration).toContain("set search_path = pg_catalog, private");
    expect(migration).toContain("not private.has_role('HR')");
    expect(migration).toContain("from public, anon");
    expect(migration).toContain("to authenticated");
    expect(migration.trim().startsWith("begin;")).toBe(true);
    expect(migration.trim().endsWith("commit;")).toBe(true);
  });
});
