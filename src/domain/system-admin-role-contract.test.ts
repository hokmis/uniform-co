import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync("supabase/migrations/0088_system_admin_all_roles.sql", "utf8");
const manualSql = readFileSync("supabase/manual/0088_system_admin_all_roles.sql", "utf8");

describe("SYSTEM_ADMIN role contract", () => {
  it("keeps the migration and manual SQL aligned", () => {
    expect(manualSql.replace(/--.*$/gm, "").replace(/\s+/g, " ").trim())
      .toBe(migration.replace(/--.*$/gm, "").replace(/\s+/g, " ").trim());
  });

  it("makes the central helper treat SYSTEM_ADMIN as the requested role", () => {
    expect(migration).toContain("ur.role_code = required_role");
    expect(migration).toContain("ur.role_code = 'SYSTEM_ADMIN'::public.app_role");
    expect(migration).toContain("private.current_account_id()");
  });
});
