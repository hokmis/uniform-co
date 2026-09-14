import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase", "migrations", "0082_master_data_item_code_qualification.sql"),
  "utf8",
).replace(/\s+/g, " ");

describe("master-data item-code qualification contract", () => {
  it("patches the deployed apply RPC with variable-first PL/pgSQL resolution", () => {
    expect(migration).toContain("pg_get_functiondef");
    expect(migration).toContain("#variable_conflict use_variable");
    expect(migration).toContain("execute patched_definition");
  });

  it("requires the SYSTEM_ADMIN-aware 0080 function before patching", () => {
    expect(migration).toContain("private.has_role(''SYSTEM_ADMIN'')");
    expect(migration).toContain("0080_master_data_system_admin_access must be applied first");
  });
});
