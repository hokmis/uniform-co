import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../supabase/migrations/0078_organization_manager_read_inactive.sql", import.meta.url),
  "utf8",
);
const manualSql = readFileSync(
  new URL("../../supabase/manual/0078_organization_manager_read_inactive.sql", import.meta.url),
  "utf8",
);

describe("organization manager inactive-row read contract", () => {
  it("keeps the manual SQL copy synchronized with the migration", () => {
    expect(manualSql.replaceAll("\r\n", "\n")).toBe(migration.replaceAll("\r\n", "\n"));
  });

  it("adds HR-only authenticated read policies without replacing active-read policies", () => {
    expect(migration).toContain("create policy institutions_management_read");
    expect(migration).toContain("create policy departments_management_read");
    expect(migration).toContain("private.current_account_id() is not null");
    expect(migration.match(/private\.has_role\('HR'\)/g)).toHaveLength(2);
    expect(migration).not.toContain("drop policy if exists institutions_active_read");
    expect(migration).not.toContain("drop policy if exists departments_active_read");
    expect(migration).not.toMatch(/for\s+(insert|update|delete)/i);
  });
});
