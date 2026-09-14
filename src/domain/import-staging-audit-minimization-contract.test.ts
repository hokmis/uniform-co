import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase", "migrations", "0073_import_staging_audit_minimization.sql"),
  "utf8",
);

const metadataHelper = migration.slice(
  migration.indexOf("create or replace function private.import_row_audit_metadata"),
  migration.indexOf("create or replace function private.audit_business_row_change"),
);

describe("import staging audit minimization migration contract", () => {
  it("uses an explicit allowlist for durable import row audit metadata", () => {
    for (const field of [
      "id",
      "batch_id",
      "row_number",
      "proposed_action",
      "target_entity_id",
      "applied_at",
    ]) {
      expect(metadataHelper).toContain(`'${field}', p_row -> '${field}'`);
    }

    expect(metadataHelper).not.toMatch(/'raw_values'\s*,/);
    expect(metadataHelper).not.toMatch(/'normalized_values'\s*,/);
    expect(metadataHelper).not.toMatch(/'validation_errors'\s*,/);
  });

  it("routes import_rows through metadata-only before and after audit payloads", () => {
    expect(migration).toContain("tg_table_schema = 'public' and tg_table_name = 'import_rows'");
    expect(migration).toContain("private.import_row_audit_metadata(to_jsonb(old))");
    expect(migration).toContain("private.import_row_audit_metadata(to_jsonb(new))");
    expect(migration).toContain("'payload_policy', 'IMPORT_ROW_METADATA_ONLY'");
  });

  it("keeps full before and after row audit for other business tables", () => {
    expect(migration).toContain("before_data := case when tg_op = 'INSERT' then null else to_jsonb(old) end");
    expect(migration).toContain("after_data := case when tg_op = 'DELETE' then null else to_jsonb(new) end");
  });

  it("does not rewrite or delete existing append-only audit history", () => {
    expect(migration).not.toMatch(/update\s+public\.audit_events/i);
    expect(migration).not.toMatch(/delete\s+from\s+public\.audit_events/i);
    expect(migration).not.toMatch(/truncate\s+(table\s+)?public\.audit_events/i);
  });
});
