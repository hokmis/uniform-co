import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(process.cwd(), "supabase/migrations/0132_atomic_return_completion.sql");
const manualPath = resolve(process.cwd(), "supabase/manual/0132_atomic_return_completion.sql");

describe("atomic return completion migration contract", () => {
  it("wraps the guarded return draft and post RPCs in one invoker transaction", () => {
    const migration = readFileSync(migrationPath, "utf8");

    expect(migration).toContain("create or replace function public.complete_return_note(");
    expect(migration).toContain("returns public.return_notes");
    expect(migration).toMatch(/language plpgsql\s+security invoker\s+set search_path = pg_catalog, private/i);
    expect(migration).toContain("public.create_return_note_draft(");
    expect(migration).toContain("public.post_return_note(");
    expect(migration).toMatch(/if\s+return_row\.status\s*=\s*'POSTED'\s+then\s+return\s+return_row/i);
    expect(migration).toMatch(/if\s+return_row\.status\s*<>\s*'DRAFT'/i);
    expect(migration).not.toMatch(/\b(?:insert|update|delete)\s+into\s+public\.(?:return_notes|return_lines|inventory_balances|inventory_ledger_entries)\b/i);
  });

  it("restricts the wrapper to authenticated callers", () => {
    const migration = readFileSync(migrationPath, "utf8").replace(/\s+/g, " ");
    const signature = "complete_return_note(text, uuid, date, text, text, text, jsonb, text, text, text, text)";

    expect(migration).toContain(`revoke all on function public.${signature} from public, anon`);
    expect(migration).toContain(`grant execute on function public.${signature} to authenticated`);
  });

  it("keeps the user-run SQL copy byte-for-byte aligned with the migration", () => {
    expect(readFileSync(manualPath, "utf8")).toBe(readFileSync(migrationPath, "utf8"));
  });
});
