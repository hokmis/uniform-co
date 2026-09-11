import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase", "migrations", "0072_import_terminal_retention.sql"),
  "utf8",
);

describe("import terminal retention migration contract", () => {
  it("adds a terminal timestamp with a status invariant", () => {
    expect(migration).toContain("add column terminal_at timestamptz");
    expect(migration).toContain("import_batches_terminal_at_status_check");
    expect(migration).toContain("status in ('FAILED', 'CANCELLED') and terminal_at is not null");
    expect(migration).toContain("status not in ('FAILED', 'CANCELLED') and terminal_at is null");
  });

  it("starts a fresh terminal clock and does not let terminal metadata updates extend it", () => {
    expect(migration).toContain("old.status not in ('FAILED', 'CANCELLED')");
    expect(migration).toContain("new.terminal_at := transaction_timestamp()");
    expect(migration).toContain("new.terminal_at := old.terminal_at");
    expect(migration).toContain("new.terminal_at := null");
    expect(migration).toContain("before insert or update of status, terminal_at on public.import_batches");
  });

  it("backfills existing terminal batches conservatively from migration time", () => {
    expect(migration).toContain("disable trigger import_batch_terminal_guard");
    expect(migration).toContain("set terminal_at = transaction_timestamp()");
    expect(migration).toContain("where status in ('FAILED', 'CANCELLED')");
    expect(migration).toContain("enable trigger import_batch_terminal_guard");
  });

  it("only exposes terminal import Storage objects after 90 days and keeps the 24 hour floor", () => {
    expect(migration).toContain("interval '24 hours'");
    expect(migration).toContain("import_row.status in ('FAILED', 'CANCELLED')");
    expect(migration).toContain("import_row.terminal_at <= transaction_timestamp() - interval '90 days'");
    expect(migration).toContain("return 'TERMINAL_IMPORT_90D'");
  });

  it("extends cleanup event validation without deleting database evidence", () => {
    expect(migration).toContain("storage_cleanup_events_candidate_type_check");
    expect(migration).toContain("'TERMINAL_IMPORT_90D'");
    expect(migration).not.toMatch(/delete\s+from\s+public\.(import_batches|import_batch_chunks|import_rows|import_field_diffs)/i);
    expect(migration).not.toMatch(/set\s+lease_expires_at/i);
  });
});
