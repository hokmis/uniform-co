import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase", "migrations", "0081_jsonb_object_length_compatibility.sql"),
  "utf8",
).replace(/\s+/g, " ");

describe("master-data JSONB compatibility contract", () => {
  it("provides the private bridge required by apply_master_import", () => {
    expect(migration).toContain("create or replace function private.jsonb_object_length(p_value jsonb)");
    expect(migration).toContain("select count(*)::integer from jsonb_object_keys(p_value)");
    expect(migration).toContain("set search_path = pg_catalog");
  });

  it("does not rely on a nonexistent PostgreSQL jsonb_object_length builtin", () => {
    expect(migration).not.toContain("jsonb_object_length(row_value)");
    expect(migration).toContain("jsonb_object_keys(p_value)");
  });
});
