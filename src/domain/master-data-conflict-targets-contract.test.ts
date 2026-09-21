import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase", "migrations", "0083_master_data_conflict_targets.sql"),
  "utf8",
);

describe("master data conflict target migration contract", () => {
  it("restores every unique key used by master-data and idempotency upserts", () => {
    expect(migration).toContain("operation_commands_operation_idempotency_conflict_idx");
    expect(migration).toContain("institutions_code_conflict_idx");
    expect(migration).toContain("departments_institution_code_conflict_idx");
    expect(migration).toContain("uniform_items_item_code_conflict_idx");
    expect(migration).toContain("suppliers_supplier_code_conflict_idx");
    expect(migration).toContain("supplier_uniform_items_supplier_item_conflict_idx");
    expect(migration).toContain("create unique index if not exists");
  });

  it("fails before index creation when existing data violates a business key", () => {
    expect(migration).toContain("group by");
    expect(migration).toContain("having count(*) > 1");
    expect(migration).toContain("errcode = '23505'");
    expect(migration).toContain("must be resolved before 0083");
  });
});
