import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase", "migrations", "0080_master_data_system_admin_access.sql"),
  "utf8",
).replace(/\s+/g, " ");

describe("master data role access contract", () => {
  it("allows SYSTEM_ADMIN to save every master-data entity", () => {
    expect(migration).toContain("private.has_role('SYSTEM_ADMIN')");
    expect(migration).toContain("if not (private.has_role('SYSTEM_ADMIN') or private.has_role('HR')");
    expect(migration).toContain("create or replace function public.apply_master_import(");
  });

  it("keeps SYSTEM_ADMIN export access aligned with master-data maintenance", () => {
    expect(migration).toContain("Role cannot export this master data");
    expect(migration).toContain("Role cannot record this export download");
    expect(migration).toContain("private.has_role('SYSTEM_ADMIN') or private.has_role('HR')");
    expect(migration).toContain("master_import_batches_read on public.master_import_batches");
    expect(migration).toContain("institutions_management_read on public.institutions");
    expect(migration).toContain("departments_management_read on public.departments");
  });
});
