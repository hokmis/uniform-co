import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = join(
  process.cwd(),
  "supabase",
  "migrations",
  "0139_purchase_receipt_correction_reopen.sql",
);
const manualPath = join(
  process.cwd(),
  "supabase",
  "manual",
  "0139_purchase_receipt_correction_reopen.sql",
);
const baselinePath = join(
  process.cwd(),
  "supabase",
  "migrations",
  "0023_receipt_draft_validation.sql",
);

function currentReceiptSql() {
  return readFileSync(existsSync(migrationPath) ? migrationPath : baselinePath, "utf8");
}

describe("purchase receipt correction and reopen accounting", () => {
  it("uses effective posted receipt quantities, including posted corrections, for the next receipt guard", () => {
    const sql = currentReceiptSql();
    const functionStart = sql.indexOf("create or replace function public.post_purchase_receipt(");
    const functionEnd = sql.indexOf("$$;", functionStart);
    const body = sql.slice(functionStart, functionEnd);

    expect(functionStart).toBeGreaterThanOrEqual(0);
    expect(body).toContain("public.purchase_receipt_correction_lines");
    expect(body).toContain("public.correction_notes");
    expect(body).toContain("correction.status = 'POSTED'");
    expect(body).toContain("correction.original_purchase_receipt_id = source_receipt.id");
    expect(body).toContain("correction_line.accepted_quantity_delta");
    expect(body).toContain("correction_line.delivered_quantity_delta");
    expect(body).toContain("remaining_to_accept := po_line_row.ordered_quantity - accepted_to_date");
  });

  it("marks a purchase order received only when every line is fully accepted after corrections", () => {
    const sql = currentReceiptSql();
    const functionStart = sql.indexOf("create or replace function public.post_purchase_receipt(");
    const functionEnd = sql.indexOf("$$;", functionStart);
    const body = sql.slice(functionStart, functionEnd);

    expect(body).toContain("where purchase_order_line.purchase_order_id = po_row.id");
    expect(body).toContain("purchase_order_line.ordered_quantity > (");
    expect(body).toContain("source_line.purchase_order_line_id = purchase_order_line.id");
    expect(body).toContain("update public.purchase_orders");
    expect(body).toContain("'PARTIALLY_RECEIVED'");
    expect(body).toContain("'RECEIVED'");
  });

  it("preserves authenticated warehouse authorization, idempotency, locking, and inventory posting", () => {
    const sql = currentReceiptSql();
    const functionStart = sql.indexOf("create or replace function public.post_purchase_receipt(");
    const functionEnd = sql.indexOf("$$;", functionStart);
    const body = sql.slice(functionStart, functionEnd);

    expect(body).toContain("not private.has_role('WAREHOUSE')");
    expect(body).toContain("'POST_PURCHASE_RECEIPT'");
    expect(body).toContain("canonical_request_fingerprint");
    expect(body).toContain("public.inventory_item_locks");
    expect(body).toContain("for update");
    expect(body).toContain("public.inventory_postings");
    expect(body).toContain("public.inventory_ledger_entries");
    expect(body).toContain("update public.inventory_balances");
    expect(sql).toContain("revoke all on function public.post_purchase_receipt(uuid, text, text)");
    expect(sql).toContain("grant execute on function public.post_purchase_receipt(uuid, text, text)");
  });

  it("keeps the SQL Editor copy byte-for-byte aligned with the migration", () => {
    expect(readFileSync(manualPath, "utf8")).toBe(readFileSync(migrationPath, "utf8"));
  });
});
