import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "supabase/migrations/0128_atomic_hr_request_submission.sql",
);

describe("atomic HR request submission migration", () => {
  it("wraps existing guarded operations in one transaction without duplicating table writes", () => {
    const sql = readFileSync(migrationPath, "utf8").toLowerCase();
    const body = sql.slice(sql.indexOf("create or replace function public.submit_hr_request_with_lines"));

    expect(sql).toMatch(/to_regprocedure\(\s*'public\.create_hr_request_draft\(text, date, text, jsonb, jsonb, text, text\)'\s*\)/);
    expect(sql).toMatch(/to_regprocedure\(\s*'public\.update_hr_request_draft\(uuid, date, text, jsonb, jsonb, text, text\)'\s*\)/);
    expect(sql).toMatch(/to_regprocedure\(\s*'public\.submit_hr_request\(uuid, text, text\)'\s*\)/);
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(body).toContain("security definer");
    expect(body).toContain("set search_path = pg_catalog, private");
    expect(body).toContain("private.has_role('hr')");
    expect(body).toContain("auth.uid() is null");
    expect(body).toContain("current_account is null");
    expect(body).toContain("public.create_hr_request_draft(");
    expect(body).toContain("public.update_hr_request_draft(");
    expect(body).toContain("public.submit_hr_request(");
    expect(body).toContain("p_submit_request_fingerprint");
    expect(body).not.toMatch(/\binsert\s+into\s+public\.(hr_requests|hr_issue_lines|hr_request_items|inventory_reservations|inventory_ledger_entries)\b/i);
    expect(body).not.toMatch(/\bupdate\s+public\.(hr_requests|hr_issue_lines|hr_request_items|inventory_reservations|inventory_ledger_entries)\b/i);
    expect(body).not.toMatch(/\bdelete\s+from\s+public\.(hr_requests|hr_issue_lines|hr_request_items|inventory_reservations|inventory_ledger_entries)\b/i);
    expect(body).toContain("revoke all on function public.submit_hr_request_with_lines");
    expect(body).toContain("grant execute on function public.submit_hr_request_with_lines");
  });
});
