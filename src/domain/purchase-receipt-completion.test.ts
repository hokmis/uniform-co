import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  completePurchaseReceipt,
  type PurchaseReceiptCompletionInput,
} from "./purchase-receipt-completion";

const input: PurchaseReceiptCompletionInput = {
  receiptNo: "GRN-2026-001",
  purchaseOrderLineId: "po-line-1",
  deliveredQuantity: 10,
  acceptedQuantity: 9,
  rejectedQuantity: 1,
  rejectionReason: "尺寸不符",
  receivedOn: "2026-09-20",
  createIdempotencyKey: "CREATE-RECEIPT-KEY",
  createRequestFingerprint: "CREATE-RECEIPT-FINGERPRINT",
  postIdempotencyKey: "POST-RECEIPT-KEY",
  postRequestFingerprint: "POST-RECEIPT-FINGERPRINT",
};

const draft = {
  id: "receipt-1",
  receipt_no: input.receiptNo,
  purchase_order_id: "po-1",
  status: "DRAFT",
  received_on: input.receivedOn,
};

const posted = { ...draft, status: "POSTED" };

describe("atomic purchase receipt completion", () => {
  it("posts through one RPC when the atomic function is installed", async () => {
    const rpc = vi.fn(async () => ({ data: posted, error: null }));

    const result = await completePurchaseReceipt(rpc, input);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("complete_purchase_receipt", {
      p_receipt_no: input.receiptNo,
      p_purchase_order_line_id: input.purchaseOrderLineId,
      p_delivered_quantity: input.deliveredQuantity,
      p_accepted_quantity: input.acceptedQuantity,
      p_rejected_quantity: input.rejectedQuantity,
      p_rejection_reason: input.rejectionReason,
      p_received_on: input.receivedOn,
      p_create_idempotency_key: input.createIdempotencyKey,
      p_create_request_fingerprint: input.createRequestFingerprint,
      p_post_idempotency_key: input.postIdempotencyKey,
      p_post_request_fingerprint: input.postRequestFingerprint,
    });
    expect(result).toEqual({
      receipt: posted,
      error: null,
      failureStage: null,
      usedLegacyFallback: false,
    });
  });

  it("uses the original idempotent draft and POST RPCs only when the atomic RPC is missing", async () => {
    const rpc = vi.fn(async (functionName: string, _args: Record<string, unknown>) => {
      if (functionName === "complete_purchase_receipt") {
        return {
          data: null,
          error: { code: "PGRST202", message: "Could not find the function public.complete_purchase_receipt in the schema cache" },
        };
      }
      if (functionName === "create_purchase_receipt_draft") return { data: draft, error: null };
      return { data: posted, error: null };
    });

    const result = await completePurchaseReceipt(rpc, input);

    expect(rpc.mock.calls.map(([functionName]) => functionName)).toEqual([
      "complete_purchase_receipt",
      "create_purchase_receipt_draft",
      "post_purchase_receipt",
    ]);
    expect(rpc.mock.calls[1]?.[1]).toMatchObject({
      p_idempotency_key: input.createIdempotencyKey,
      p_request_fingerprint: input.createRequestFingerprint,
    });
    expect(rpc.mock.calls[2]?.[1]).toMatchObject({
      p_receipt_id: draft.id,
      p_idempotency_key: input.postIdempotencyKey,
      p_request_fingerprint: input.postRequestFingerprint,
    });
    expect(result).toEqual({
      receipt: posted,
      error: null,
      failureStage: null,
      usedLegacyFallback: true,
    });
  });

  it("does not repeat a missing atomic-RPC probe for the same database client", async () => {
    const capabilityOwner = {};
    const calls: string[] = [];
    const rpc = vi.fn(async (functionName: string) => {
      calls.push(functionName);
      if (functionName === "complete_purchase_receipt") {
        return {
          data: null,
          error: { code: "PGRST202", message: "Could not find the function public.complete_purchase_receipt in the schema cache" },
        };
      }
      if (functionName === "create_purchase_receipt_draft") return { data: draft, error: null };
      return { data: posted, error: null };
    });

    await completePurchaseReceipt(rpc, input, capabilityOwner);
    await completePurchaseReceipt(rpc, input, capabilityOwner);

    expect(calls.filter((functionName) => functionName === "complete_purchase_receipt")).toHaveLength(1);
    expect(calls).toEqual([
      "complete_purchase_receipt", "create_purchase_receipt_draft", "post_purchase_receipt",
      "create_purchase_receipt_draft", "post_purchase_receipt",
    ]);
  });

  it("returns the saved draft when a legacy POST fails so the user can retry without recreating it", async () => {
    const postError = { code: "40001", message: "retry posting" };
    const rpc = vi.fn(async (functionName: string, _args: Record<string, unknown>) => {
      if (functionName === "complete_purchase_receipt") {
        return { data: null, error: { code: "42883", message: "function public.complete_purchase_receipt does not exist" } };
      }
      if (functionName === "create_purchase_receipt_draft") return { data: draft, error: null };
      return { data: null, error: postError };
    });

    const result = await completePurchaseReceipt(rpc, input);

    expect(result).toEqual({
      receipt: draft,
      error: postError,
      failureStage: "post",
      usedLegacyFallback: true,
    });
  });

  it("recovers a completed legacy operation when its POST response was lost", async () => {
    const rpc = vi.fn(async (functionName: string, _args: Record<string, unknown>) => {
      if (functionName === "complete_purchase_receipt") {
        return { data: null, error: { code: "PGRST202", message: "Could not find the function public.complete_purchase_receipt in the schema cache" } };
      }
      return { data: posted, error: null };
    });

    const result = await completePurchaseReceipt(rpc, input);

    expect(rpc.mock.calls.map(([functionName]) => functionName)).toEqual([
      "complete_purchase_receipt",
      "create_purchase_receipt_draft",
    ]);
    expect(result).toEqual({
      receipt: posted,
      error: null,
      failureStage: null,
      usedLegacyFallback: true,
    });
  });

  it("returns a retryable outcome instead of throwing when the atomic response is lost", async () => {
    const rpc = vi.fn(async () => { throw new Error("untrusted transport message"); });

    const result = await completePurchaseReceipt(rpc, input);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      receipt: null,
      error: null,
      failureStage: "complete",
      usedLegacyFallback: false,
    });
  });

  it("preserves the draft and reports a retryable outcome when the legacy POST response is lost", async () => {
    const rpc = vi.fn(async (functionName: string, _args: Record<string, unknown>) => {
      if (functionName === "complete_purchase_receipt") {
        return { data: null, error: { code: "42883", message: "function public.complete_purchase_receipt does not exist" } };
      }
      if (functionName === "create_purchase_receipt_draft") return { data: draft, error: null };
      throw new Error("untrusted transport message");
    });

    const result = await completePurchaseReceipt(rpc, input);

    expect(result).toEqual({
      receipt: draft,
      error: null,
      failureStage: "post",
      usedLegacyFallback: true,
    });
  });

  it("does not fall back on permission or business errors", async () => {
    const error = { code: "42501", message: "permission denied" };
    const rpc = vi.fn(async () => ({ data: null, error }));

    const result = await completePurchaseReceipt(rpc, input);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      receipt: null,
      error,
      failureStage: "complete",
      usedLegacyFallback: false,
    });
  });

  it("checks WAREHOUSE and locks the item before delegating in one protected transaction", () => {
    const migration = readFileSync(
      resolve(process.cwd(), "supabase/migrations/0126_atomic_purchase_receipt_completion.sql"),
      "utf8",
    );

    expect(migration).toContain("create or replace function public.complete_purchase_receipt(");
    expect(migration).toContain("security definer");
    const roleGate = migration.indexOf("not private.has_role('WAREHOUSE')");
    const itemLock = migration.indexOf("perform 1 from public.inventory_item_locks");
    const createDraft = migration.indexOf("public.create_purchase_receipt_draft(");
    expect(roleGate).toBeGreaterThan(-1);
    expect(itemLock).toBeGreaterThan(roleGate);
    expect(createDraft).toBeGreaterThan(itemLock);
    expect(migration).toContain("auth.uid() is null");
    expect(migration).toContain("insert into public.inventory_item_locks");
    expect(migration).toContain("public.create_purchase_receipt_draft(");
    expect(migration).toContain("public.post_purchase_receipt(");
    expect(migration).toContain("revoke all on function public.complete_purchase_receipt");
    expect(migration).toContain("to authenticated");
    expect(migration).not.toMatch(/insert into public\.(purchase_receipts|inventory_balances|inventory_ledger_entries)/i);
  });
});
