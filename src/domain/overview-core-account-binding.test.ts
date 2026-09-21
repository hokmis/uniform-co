import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(resolve(process.cwd(), "supabase/migrations/0129_overview_core_account_binding.sql"), "utf8");
const restoreSql = readFileSync(resolve(process.cwd(), "supabase/manual/restore-application-read-models.sql"), "utf8");
const verificationSql = readFileSync(resolve(process.cwd(), "supabase/manual/verify-application-read-models.sql"), "utf8");

describe("overview account-bound snapshot", () => {
  it("resolves account_id inside the same security-invoker statement as its summaries", () => {
    expect(migration).toContain("with (security_invoker = true)");
    expect(migration).toContain("where account_row.auth_user_id = auth.uid()");
    expect(migration).toContain("from public.app_accounts account_row");
    expect(migration.indexOf("as receipts,")).toBeLessThan(migration.indexOf("as account_id;"));
    expect(migration).toContain("revoke all on table public.v_overview_core from public, anon, authenticated");
    expect(migration).toContain("grant select on public.v_overview_core to authenticated");
  });

  it("keeps the manual read-model restore and postflight aligned with migration 0129", () => {
    expect(restoreSql).toContain("Source: supabase/migrations/0129_overview_core_account_binding.sql");
    expect(restoreSql).toContain("where account_row.auth_user_id = auth.uid()");
    expect(restoreSql).toContain("Overview account snapshot binding is missing.");
    expect(verificationSql).toContain("overview_snapshot_account_bound");
    expect(verificationSql).toContain("attribute_row.attname = 'account_id'");
  });
});
