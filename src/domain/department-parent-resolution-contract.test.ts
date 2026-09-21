import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase", "migrations", "0087_department_parent_resolution.sql"),
  "utf8",
).replace(/\s+/g, " ");

describe("department parent resolution contract", () => {
  it("prefers the current institution id and keeps a code fallback", () => {
    expect(migration).toContain("row_value ->> 'institutionId'");
    expect(migration).toContain("i.id = (row_value ->> 'institutionId')::uuid");
    expect(migration).toContain("i.code = btrim(row_value ->> 'institutionCode')");
    expect(migration).toContain("raise exception using errcode = '23503'");
  });
});
