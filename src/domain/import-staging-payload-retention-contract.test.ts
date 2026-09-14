import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase", "migrations", "0074_import_staging_payload_retention.sql"),
  "utf8",
).replace(/\r\n/g, "\n");
const candidateSql = migration.split(
  "create or replace function public.list_import_staging_retention_candidates",
)[1]?.split("create or replace function public.purge_import_staging_payload")[0] ?? "";
const purgeSql = migration.split(
  "create or replace function public.purge_import_staging_payload",
)[1] ?? "";

describe("import staging payload retention migration contract", () => {
  it("creates a dedicated fail-closed import retention role and actor gate", () => {
    expect(migration).toContain("create role job_import_retention noinherit nologin");
    expect(migration).toContain("alter role job_import_retention nologin noinherit");
    expect(migration).toContain("session_user <> 'job_import_retention'");
    expect(migration).toContain("private.execution_actor_id()");
    expect(migration).toContain("bound import retention actor is required");
  });

  it("marks whole-batch purge evidence only after the terminal 90-day window", () => {
    expect(migration).toContain("add column staging_purged_at timestamptz");
    expect(migration).toContain("import_batches_staging_purged_at_check");
    expect(migration).toContain("staging_purged_at >= terminal_at + interval '90 days'");
    expect(migration).toContain("b.staging_purged_at is null");
    expect(migration).toContain("b.terminal_at <= transaction_timestamp() - interval '90 days'");
  });

  it("scrubs only purgeable import row payload and keeps durable row shells", () => {
    expect(migration).toContain("set raw_values = '{}'::jsonb");
    expect(migration).toContain("normalized_values = null");
    expect(migration).toContain("validation_errors = '[]'::jsonb");
    expect(migration).not.toMatch(/delete\s+from\s+public\.(import_batches|import_batch_chunks|import_rows|import_field_diffs)/i);
    expect(migration).not.toMatch(/update\s+public\.import_field_diffs/i);
  });

  it("locks and rechecks the batch before an atomic idempotent purge", () => {
    expect(migration).toContain("where b.id = p_batch_id\n    for update");
    expect(migration).toContain("if batch_row.staging_purged_at is not null then");
    expect(migration).toContain("batch_row.status not in ('FAILED', 'CANCELLED')");
    expect(migration).toContain("batch_row.terminal_at > transaction_timestamp() - interval '90 days'");
    expect(migration).toContain("set staging_purged_at = transaction_timestamp()");
  });

  it("keeps the terminal guard exception narrow for retention writes", () => {
    expect(migration).toContain("tg_table_name = 'import_rows'");
    expect(migration).toContain("session_user = 'job_import_retention'");
    expect(migration).toContain("to_jsonb(new) - array['raw_values', 'normalized_values', 'validation_errors']::text[]");
    expect(migration).toContain("tg_table_name = 'import_batches'");
    expect(migration).toContain("to_jsonb(new) - 'staging_purged_at'");
    expect(migration).toContain("b.status in ('APPLIED', 'CANCELLED')");
  });

  it("prevents restarting a batch after its staging payload was purged", () => {
    expect(migration).toContain("Import batch with purged staging payload is terminal");
    expect(migration).toContain("new.status not in ('FAILED', 'CANCELLED')");
    expect(migration).toContain("before insert or update of status, terminal_at, staging_purged_at on public.import_batches");
  });

  it("exposes only thin retention RPCs and no direct table DML", () => {
    expect(migration).toContain("public.list_import_staging_retention_candidates");
    expect(migration).toContain("public.purge_import_staging_payload");
    expect(migration).toContain("from job_import_retention");
    expect(migration).toContain("grant execute on function public.list_import_staging_retention_candidates(integer) to job_import_retention");
    expect(migration).toContain("grant execute on function public.purge_import_staging_payload(uuid) to job_import_retention");
  });

  it("never makes APPLIED imports eligible for staging purge", () => {
    expect(candidateSql).not.toContain("APPLIED");
    expect(purgeSql).not.toContain("APPLIED");
    expect(candidateSql).toContain("b.status in ('FAILED', 'CANCELLED')");
    expect(purgeSql).toContain("batch_row.status not in ('FAILED', 'CANCELLED')");
  });
});
