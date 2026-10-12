import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = (name: string) => readFileSync(resolve(process.cwd(), "supabase", "migrations", name), "utf8");

function functionBody(source: string, functionName: string): string {
  const start = source.indexOf(`create or replace function public.${functionName}(`);
  if (start < 0) return "";
  const end = source.indexOf("\n$$;", start);
  return end < 0 ? "" : source.slice(start, end + 4);
}

describe("correction inventory posting contract", () => {
  it("posts warehouse transfer corrections as two balanced ledger movements and updates both warehouses", () => {
    const body = functionBody(migration("0054_warehouse_transfer_correction.sql"), "post_warehouse_transfer_correction");

    expect(body).toContain("insert into public.inventory_ledger_entries");
    expect(body).toContain("'WAREHOUSE_TRANSFER_CORRECTION_OUT'");
    expect(body).toContain("'WAREHOUSE_TRANSFER_CORRECTION_IN'");
    expect(body).toContain("on_hand_quantity = on_hand_quantity - correction_line.transfer_quantity_delta");
    expect(body).toContain("on_hand_quantity = on_hand_quantity + correction_line.transfer_quantity_delta");
    expect(body).toContain("update public.inventory_balances");
    expect(body).toContain("set status = 'POSTED'");
  });

  it("posts stocktake corrections as a ledger movement and updates the source warehouse balance", () => {
    const body = functionBody(migration("0055_stocktake_correction.sql"), "post_stocktake_correction");

    expect(body).toContain("insert into public.inventory_ledger_entries");
    expect(body).toContain("'STOCKTAKE_CORRECTION'");
    expect(body).toContain("correction_line.counted_quantity_delta");
    expect(body).toContain("set on_hand_quantity = on_hand_quantity + correction_line.counted_quantity_delta");
    expect(body).toContain("set status = 'POSTED'");
  });

  it("exposes correction ledger entries in the item movement history and resolves their source number", () => {
    const view = migration("0065_inventory_history_source_number.sql");

    expect(view).toContain("from public.inventory_ledger_entries le");
    expect(view).toContain("when 'CORRECTION' then");
    expect(view).toContain("from public.correction_posting_sources cps");
    expect(view).toContain("join public.correction_notes c");
    expect(view).not.toMatch(/where[\s\S]*posting_kind\s*(?:=|in)[\s\S]*(?:WAREHOUSE_SHIPMENT|STOCKTAKE)/i);
  });

  it("cannot mark a transfer or stocktake correction POSTED unless its ledger and balance effects exist", () => {
    const guard = migration("0136_correction_inventory_effect_guard.sql");

    expect(guard).toContain("create or replace function private.assert_correction_inventory_effect()");
    expect(guard).toContain("before update of status on public.correction_notes");
    expect(guard).toContain("WAREHOUSE_TRANSFER_CORRECTION_OUT");
    expect(guard).toContain("WAREHOUSE_TRANSFER_CORRECTION_IN");
    expect(guard).toContain("STOCKTAKE_CORRECTION");
    expect(guard).toContain("last_posting_id");
    expect(guard).toContain("Correction inventory balance update is incomplete");
    expect(guard).toContain("Correction inventory ledger is incomplete");
  });

  it("keeps the SQL Editor copy byte-for-byte aligned with the versioned migration", () => {
    const migrationSql = migration("0136_correction_inventory_effect_guard.sql");
    const manualSql = readFileSync(resolve(process.cwd(), "supabase", "manual", "0136_correction_inventory_effect_guard.sql"), "utf8");

    expect(manualSql).toBe(migrationSql);
  });

  it("reconciles current balances against the complete ledger when later postings supersede last_posting_id", () => {
    const verifier = readFileSync(resolve(process.cwd(), "supabase", "manual", "verify-correction-inventory-posting.sql"), "utf8");

    expect(verifier).toContain("evidence.balance_reconciliation_count");
    expect(verifier).toContain("sum(all_ledger.quantity_delta)");
    expect(verifier).toContain("OK_BALANCES_RECONCILE_AFTER_LATER_POSTINGS");
    expect(verifier).toContain("CHECK_BALANCE_NOT_UPDATED");
    expect(verifier).toContain("last_posting_pointer_count");
  });

  it("reports correction RPC and inventory guard readiness in the same read-only diagnostic", () => {
    const verifier = readFileSync(resolve(process.cwd(), "supabase", "manual", "verify-correction-inventory-posting.sql"), "utf8");

    expect(verifier).toContain("DATABASE_READINESS");
    expect(verifier).toContain("public.complete_warehouse_transfer_correction(text,text,uuid,bigint,text,text,text,text,text,text)");
    expect(verifier).toContain("public.complete_stocktake_correction(text,uuid,bigint,text,text,text,text,text,text)");
    expect(verifier).toContain("public.create_warehouse_transfer_correction_draft(text,text,uuid,bigint,text,text,text,text)");
    expect(verifier).toContain("public.create_stocktake_correction_draft(text,uuid,bigint,text,text,text,text)");
    expect(verifier).toContain("correction_notes_inventory_effect_guard");
    expect(verifier).toContain("assert_correction_inventory_effect");
    expect(verifier).toContain("REQUIRED_CORRECTION_RPC_MISSING");
    expect(verifier).toContain("INVENTORY_EFFECT_GUARD_MISSING");
    expect(verifier).toContain("LEGACY_FALLBACK_AVAILABLE");
    expect(verifier).toContain("'RECENT_CORRECTION'::text as record_type");
    expect(verifier).not.toMatch(/^\s*(insert|update|delete|alter|create|drop)\b/im);
  });

  it("distinguishes an RPC that exists from one authenticated users can actually execute", () => {
    const verifier = readFileSync(resolve(process.cwd(), "supabase", "manual", "verify-correction-inventory-posting.sql"), "utf8");

    expect(verifier).toContain("has_function_privilege('authenticated'");
    for (const capability of [
      "transfer_completion_execute_granted",
      "transfer_create_execute_granted",
      "transfer_post_execute_granted",
      "stocktake_completion_execute_granted",
      "stocktake_create_execute_granted",
      "stocktake_post_execute_granted",
    ]) {
      expect(verifier).toContain(capability);
    }
    expect(verifier).toContain("readiness_flags");
    expect(verifier).toContain("array_remove(array[");
    expect(verifier).toContain("'LEGACY_FALLBACK_AVAILABLE'");
    expect(verifier).toContain("'INVENTORY_EFFECT_GUARD_MISSING'");
  });

  it("shows whether create/post commands reached the database without exposing operation keys", () => {
    const verifier = readFileSync(resolve(process.cwd(), "supabase", "manual", "verify-correction-inventory-posting.sql"), "utf8");

    expect(verifier).toContain("'OPERATION_SUMMARY'::text as record_type");
    expect(verifier).toContain("operation_count");
    expect(verifier).toContain("succeeded_count");
    for (const operation of [
      "CREATE_WAREHOUSE_TRANSFER_CORRECTION",
      "POST_WAREHOUSE_TRANSFER_CORRECTION",
      "CREATE_STOCKTAKE_CORRECTION",
      "POST_STOCKTAKE_CORRECTION",
    ]) {
      expect(verifier).toContain(operation);
    }
    expect(verifier).not.toContain("canonical_request_fingerprint");
    expect(verifier).not.toContain("actor_account_id");
    expect(verifier).not.toContain("idempotency_key");
  });

  it("does not imply a rolled-back RPC was never attempted when no command row remains", () => {
    const verifier = readFileSync(resolve(process.cwd(), "supabase", "manual", "verify-correction-inventory-posting.sql"), "utf8");

    expect(verifier).toContain("NO_PERSISTED_RPC_COMMAND");
    expect(verifier).toMatch(/failed RPC transactions? can roll back command rows/i);
    expect(verifier).not.toContain("NO_RPC_COMMAND_RECORDED");
  });
});
