import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const verifier = readFileSync(
  resolve(process.cwd(), "supabase/manual/verify-purchase-receipt-runtime.sql"),
  "utf8",
);

describe("purchase receipt rollback-only runtime verifier", () => {
  it("runs in one serializable transaction and rolls back all QA fixtures", () => {
    expect(verifier).toMatch(/begin\s+isolation level serializable\s*;/i);
    expect(verifier).toMatch(/\nrollback\s*;\s*\nselect/i);
    expect(verifier).toContain("qa_purchase_order_absent_after_rollback");
    expect(verifier).toContain("qa_receipt_absent_after_rollback");
    expect(verifier).toContain("qa_commands_absent_after_rollback");
  });

  it("uses the authenticated purchase and receipt RPCs and retries identical input", () => {
    expect(verifier).toContain("set local role authenticated");
    expect(verifier).toContain("public.set_seasonal_procurement_line(");
    expect(verifier).toContain("public.create_purchase_order(");
    expect(verifier).toContain(
      "'public.create_purchase_order(text,uuid,bigint,date,date,character,numeric,numeric,text,text)'",
    );
    expect(verifier).toContain("public.complete_purchase_receipt(");
    expect(verifier).toContain("retry_receipt := public.complete_purchase_receipt(");
    expect(verifier).toContain("purchase_receipt_inventory_delta_correct");
    expect(verifier).toContain("receipt_retry_did_not_duplicate_posting");
  });

  it("never writes receipt or inventory business rows directly", () => {
    expect(verifier).not.toMatch(/\b(insert\s+into|update|delete\s+from)\s+public\.(purchase_receipts|purchase_receipt_lines|inventory_balances|inventory_postings|inventory_ledger_entries)\b/i);
  });
});
