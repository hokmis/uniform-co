import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase", "migrations", "0071_storage_cleanup_contract.sql"),
  "utf8",
);

describe("storage cleanup migration contract", () => {
  it("requires the exact cleanup session role and a bound execution actor", () => {
    expect(migration).toContain("session_user <> 'job_storage_cleanup'");
    expect(migration).toContain("private.execution_actor_id()");
  });

  it("uses a fixed bucket/path allowlist and a 24 hour object-age floor", () => {
    expect(migration).toContain("'uniform-imports', 'uniform-pdf', 'uniform-erp'");
    expect(migration).toContain("interval '24 hours'");
    expect(migration).toContain("^imports/");
    expect(migration).toContain("^pdf/");
    expect(migration).toContain("^erp/");
  });

  it("protects READY artifacts, APPLIED imports, live imports and succeeded attempts from cleanup", () => {
    expect(migration).toContain("from public.document_artifacts");
    expect(migration).toContain("from public.erp_export_artifacts");
    expect(migration).toContain("import_row.status = 'AWAITING_UPLOAD'");
    expect(migration).toContain("APPLIED and all live states are retained");
    expect(migration).toContain("document_attempt.status = 'FAILED'");
    expect(migration).toContain("document_attempt.status = 'RENDERING'");
    expect(migration).toContain("erp_attempt.status = 'FAILED'");
    expect(migration).toContain("erp_attempt.status = 'RENDERING'");
    expect(migration).not.toMatch(/status\s*=\s*'SUCCEEDED'[\s\S]*return\s+'(?:FAILED|EXPIRED|UNREFERENCED)/);
  });

  it("keeps cleanup events append-only and browser roles unable to call cleanup RPCs", () => {
    expect(migration).toContain("storage_cleanup_events_append_only");
    expect(migration).toContain("private.reject_append_only_mutation()");
    expect(migration).toContain("revoke all on function public.list_storage_cleanup_candidates(integer) from public, anon, authenticated");
    expect(migration).toContain("revoke all on function public.confirm_storage_cleanup_candidate(text, text) from public, anon, authenticated");
    expect(migration).toContain("grant execute on function public.list_storage_cleanup_candidates(integer) to job_storage_cleanup");
    expect(migration).toContain("grant execute on function public.confirm_storage_cleanup_candidate(text, text) to job_storage_cleanup");
  });

  it("does not reset or extend any lease", () => {
    expect(migration).not.toMatch(/update\s+public\.(document_render_attempts|erp_export_render_attempts|import_batches)/i);
    expect(migration).not.toMatch(/set\s+lease_expires_at/i);
  });
});
