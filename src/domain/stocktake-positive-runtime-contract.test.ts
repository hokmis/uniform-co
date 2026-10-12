import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("positive production stocktake runtime verification", () => {
  it("uses the authenticated atomic RPC, verifies ledger/balance effects, compensates, and rolls back", () => {
    const script = fs.readFileSync(
      path.resolve("supabase", "manual", "verify-stocktake-positive-runtime.sql"),
      "utf8",
    );
    const postflight = script.slice(script.toLowerCase().lastIndexOf("rollback;"));

    expect(script.trimStart().toLowerCase()).toMatch(/^--.*production.*stocktake/);
    expect(script.toLowerCase()).toContain("begin;");
    expect(script).toContain("set local role authenticated;");
    expect(script).toContain("QA-STOCKTAKE-RUNTIME-ROLLBACK-V1");
    expect(script).toContain("Reserved QA runtime identifier already exists; no data was changed");
    expect(script).toContain("public.complete_stocktake(");
    expect(script).toContain("first_count := before_quantity + 1");
    expect(script).toContain("restore_count := before_quantity");
    expect(script).toContain("first_result.status <> 'POSTED'");
    expect(script).toContain("restore_result.status <> 'POSTED'");
    expect(script).toContain("STOCKTAKE_ADJUSTMENT");
    expect(script).toContain("first_ledger_rows <> 1 or first_delta <> 1");
    expect(script).toContain("restore_ledger_rows <> 1 or restore_delta <> -1");
    expect(script).toContain("after_first_quantity <> before_quantity + 1");
    expect(script).toContain("after_restore_quantity <> before_quantity");
    expect(script).toContain("first_delta + restore_delta <> 0");
    expect(script.toLowerCase()).toMatch(/rollback;[\s\S]*select/);
    expect(script).toMatch(/from public\.inventory_reservations[\s\S]*status = 'ACTIVE'/);
    expect(postflight).toContain("true as one_step_positive_stocktake_posted");
    expect(postflight).toContain("true as ledger_and_balance_changed_together");
    expect(postflight).toContain("true as compensating_stocktake_restored_original_quantity");
    expect(postflight).toContain("as no_qa_stocktake_documents");
    expect(postflight).toContain("as no_qa_inventory_postings");
    expect(postflight).toContain("as no_qa_operation_commands");
    expect(script).not.toMatch(/\b(insert\s+into|update|delete\s+from|truncate(?:\s+table)?)\s+public\.(inventory_balances|inventory_ledger_entries|inventory_postings|stocktakes|stocktake_lines)\b/i);
  });
});
