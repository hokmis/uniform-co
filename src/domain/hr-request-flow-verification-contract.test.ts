import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const verificationPath = join(
  process.cwd(),
  "supabase",
  "manual",
  "verify-hr-request-flow.sql",
);

describe("HR request flow verification contract", () => {
  it("covers every public RPC seam in the request-to-issue workflow", async () => {
    const sql = await readFile(verificationPath, "utf8");
    for (const routineName of [
      "create_hr_request_draft",
      "update_hr_request_draft",
      "update_hr_request",
      "submit_hr_request",
      "submit_hr_request_with_lines",
      "cancel_hr_request",
      "create_warehouse_shipment_draft",
      "post_warehouse_shipment",
      "create_replenishment_draft",
      "submit_replenishment_request",
      "post_replenishment_request",
      "post_replenishment_request_with_lines",
      "cancel_replenishment_request",
      "create_return_note_draft",
      "post_return_note",
      "create_return_correction_draft",
      "post_return_correction",
      "create_hr_issue_correction_draft",
      "post_hr_issue_correction",
    ]) {
      expect(sql).toContain(`('${routineName}'::name)`);
    }
  });

  it("checks that every posting path writes both posting metadata and ledger entries", async () => {
    const sql = await readFile(verificationPath, "utf8");
    expect(sql).toContain("post_warehouse_shipment");
    expect(sql).toContain("post_replenishment_request");
    expect(sql).toContain("post_return_note");
    expect(sql).toContain("post_return_correction");
    expect(sql).toContain("post_hr_issue_correction");
    expect(sql).toContain("insert into public.inventory_postings");
    expect(sql).toContain("insert into public.inventory_ledger_entries");
  });
});
