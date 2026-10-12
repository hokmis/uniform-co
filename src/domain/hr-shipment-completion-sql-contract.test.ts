import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(process.cwd(), "supabase", "migrations", "0137_atomic_hr_warehouse_shipment_completion.sql");
const manualPath = resolve(process.cwd(), "supabase", "manual", "0137_atomic_hr_warehouse_shipment_completion.sql");

function functionBody(source: string, functionName: string): string {
  const start = source.indexOf(`create or replace function public.${functionName}(`);
  if (start < 0) return "";
  const end = source.indexOf("\n$$;", start);
  return end < 0 ? "" : source.slice(start, end + 4);
}

describe("atomic HR warehouse shipment completion migration", () => {
  it("provides one authorized, idempotent operation that creates and posts in the same transaction", () => {
    const sql = readFileSync(migrationPath, "utf8");
    const body = functionBody(sql, "complete_hr_warehouse_shipment_with_lines");

    expect(body).not.toBe("");
    expect(body).toMatch(/security definer/i);
    expect(body).toContain("auth.uid() is null");
    expect(body).toContain("private.has_role('WAREHOUSE')");
    expect(body).toContain("p_expected_row_version");
    expect(body).toContain("p_lines");
    expect(body).toContain("COMPLETE_HR_WAREHOUSE_SHIPMENT");
    expect(body).toContain("public.create_warehouse_shipment_draft(");
    expect(body).toContain("public.post_warehouse_shipment(");
    expect(body).toContain("status = 'SUCCEEDED'");
    expect(sql).toContain("grant execute on function public.complete_hr_warehouse_shipment_with_lines");
  });

  it("acquires all sorted item mutexes before locking the HR request, then rejects a changed item set", () => {
    const sql = readFileSync(migrationPath, "utf8");
    const body = functionBody(sql, "complete_hr_warehouse_shipment_with_lines");
    const itemMutexes = body.indexOf("public.inventory_item_locks");
    const requestLock = body.indexOf("from public.hr_requests");
    const createDraft = body.indexOf("public.create_warehouse_shipment_draft(");

    expect(itemMutexes).toBeGreaterThan(-1);
    expect(requestLock).toBeGreaterThan(itemMutexes);
    expect(createDraft).toBeGreaterThan(requestLock);
    expect(body).toMatch(/order by requested\.item_id/);
    expect(body).toContain("item set changed while locking");
  });

  it("fails the whole completion if any reviewed line is missing or no longer belongs to the request", () => {
    const sql = readFileSync(migrationPath, "utf8");
    const body = functionBody(sql, "complete_hr_warehouse_shipment_with_lines");

    expect(body).toContain("Shipment lines changed; reload the request and retry");
    expect(body).toContain("get diagnostics updated_count = row_count");
    expect(body).toContain("if updated_count <> 1");
  });

  it("keeps SQL Editor instructions byte-for-byte aligned with the migration", () => {
    expect(readFileSync(manualPath, "utf8")).toBe(readFileSync(migrationPath, "utf8"));
  });
});
