import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase", "migrations", "0075_pgcrypto_digest_search_path.sql"),
  "utf8",
).replace(/\s+/g, " ");
const manualFix = readFileSync(
  join(process.cwd(), "supabase", "manual", "fix-pgcrypto-digest-search-path.sql"),
  "utf8",
).replace(/\s+/g, " ");

describe("pgcrypto digest compatibility", () => {
  it("bridges restricted RPC search paths to the Supabase pgcrypto schema", () => {
    for (const sql of [migration, manualFix]) {
      expect(sql).toContain("create or replace function private.digest(");
      expect(sql).toContain("set search_path = pg_catalog, private");
      expect(sql).toContain("pg_catalog.pg_proc");
      expect(sql).toContain("pg_catalog.pg_extension");
      expect(sql).toContain("execute format('select %I.digest($1, $2)', digest_schema)");
    }
  });
});
