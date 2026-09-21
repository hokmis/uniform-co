import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase", "migrations", "0089_hr_request_workflow.sql"),
  "utf8",
);

describe("HR request workflow migration contract", () => {
  it("updates HR request drafts through an idempotent, owner-checked RPC", () => {
    expect(migration).toContain("create or replace function public.update_hr_request_draft");
    expect(migration).toContain("create or replace function public.update_hr_request(");
    expect(migration).toContain("create or replace function public.update_replenishment_request_draft");
    expect(migration).toContain("add column if not exists cancelled_at timestamptz");
    expect(migration).toContain("add column if not exists cancellation_reason text");
    expect(migration).toContain("'UPDATE_HR_REQUEST_DRAFT'");
    expect(migration).toContain("'UPDATE_HR_REQUEST'");
    expect(migration).toContain("'UPDATE_REPLENISHMENT_REQUEST_DRAFT'");
    expect(migration).toContain("Only DRAFT HR requests can be updated");
    expect(migration).toContain("delete from public.hr_issue_lines");
    expect(migration).toContain("delete from public.hr_request_items");
    expect(migration).toContain("grant execute on function public.update_hr_request_draft");
    expect(migration).toContain("grant execute on function public.update_replenishment_request_draft");
    expect(migration).toContain("Only pre-shipment HR requests can be updated");
    expect(migration).toContain("status = 'SUBMITTED', submitted_at = now(), submitted_by = current_account");
    expect(migration).toContain("on conflict (source_hr_request_id, item_id) do update");
    expect(migration.indexOf("insert into public.inventory_item_locks"))
      .toBeLessThan(migration.indexOf("select * into request_row from public.hr_requests where id = p_request_id for update"));
    expect(migration.indexOf("insert into public.inventory_item_locks"))
      .toBeLessThan(migration.indexOf("select * into request_row from public.replenishment_requests where id = p_request_id for update"));
  });

  it("provides cancellation RPCs that are separate from destructive deletion", () => {
    expect(migration).toContain("create or replace function public.cancel_hr_request");
    expect(migration).toContain("create or replace function public.cancel_replenishment_request");
    expect(migration).toContain("'CANCEL_HR_REQUEST'");
    expect(migration).toContain("'CANCEL_REPLENISHMENT_REQUEST'");
    expect(migration).not.toMatch(/delete\s+from\s+public\.(hr_requests|replenishment_requests)/i);
  });
});
