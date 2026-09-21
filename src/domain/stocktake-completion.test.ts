import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  completeStocktakeOperation,
  type StocktakeCompletionInput,
} from "./stocktake-completion";

const input: StocktakeCompletionInput = {
  stocktake: {
    id: "stocktake-1",
    stocktake_no: "COUNT-20260920-ABC123",
    warehouse_id: "warehouse-1",
    status: "DRAFT",
    note: "盤點備註",
  },
  stocktakeNo: "COUNT-20260920-ABC123",
  warehouseId: "warehouse-1",
  note: "盤點備註",
  lines: [
    { item_id: "item-1", counted_quantity: 12, reason: "盤點差異" },
  ],
  createIdempotencyKey: "CREATE-STOCKTAKE-KEY",
  createRequestFingerprint: "CREATE-STOCKTAKE-FINGERPRINT",
  updateIdempotencyKey: "UPDATE-STOCKTAKE-KEY",
  updateRequestFingerprint: "UPDATE-STOCKTAKE-FINGERPRINT",
  postIdempotencyKey: "POST-STOCKTAKE-KEY",
  postRequestFingerprint: "POST-STOCKTAKE-FINGERPRINT",
};

const posted = {
  id: "stocktake-1",
  stocktake_no: input.stocktakeNo,
  warehouse_id: input.warehouseId,
  status: "POSTED",
  note: input.note,
};
const draft = { ...posted, status: "DRAFT" };

describe("atomic stocktake completion", () => {
  it("updates and posts an existing draft through one RPC", async () => {
    const rpc = vi.fn(async () => ({ data: posted, error: null }));

    const result = await completeStocktakeOperation(rpc, input);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("complete_stocktake", {
      p_stocktake_id: input.stocktake?.id,
      p_stocktake_no: input.stocktakeNo,
      p_warehouse_id: input.warehouseId,
      p_note: input.note,
      p_lines: [{ itemId: "item-1", countedQuantity: 12, reason: "盤點差異" }],
      p_create_idempotency_key: input.createIdempotencyKey,
      p_create_request_fingerprint: input.createRequestFingerprint,
      p_update_idempotency_key: input.updateIdempotencyKey,
      p_update_request_fingerprint: input.updateRequestFingerprint,
      p_post_idempotency_key: input.postIdempotencyKey,
      p_post_request_fingerprint: input.postRequestFingerprint,
    });
    expect(result).toEqual({
      stocktake: posted,
      error: null,
      failureStage: null,
      usedLegacyFallback: false,
    });
  });

  it("creates and posts an unsaved count in one RPC", async () => {
    const rpc = vi.fn(async () => ({ data: { ...posted, id: "stocktake-new" }, error: null }));

    await completeStocktakeOperation(rpc, { ...input, stocktake: null });

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("complete_stocktake", expect.objectContaining({
      p_stocktake_id: null,
      p_create_idempotency_key: input.createIdempotencyKey,
      p_post_idempotency_key: input.postIdempotencyKey,
    }));
  });

  it("uses the existing idempotent update and POST RPCs only when the atomic RPC is missing", async () => {
    const rpc = vi.fn(async (functionName: string, _args: Record<string, unknown>) => {
      if (functionName === "complete_stocktake") {
        return { data: null, error: { code: "PGRST202", message: "Could not find the function public.complete_stocktake in the schema cache" } };
      }
      return { data: functionName === "update_stocktake_draft" ? draft : posted, error: null };
    });

    const result = await completeStocktakeOperation(rpc, input);

    expect(rpc.mock.calls.map(([functionName]) => functionName)).toEqual([
      "complete_stocktake",
      "update_stocktake_draft",
      "post_stocktake",
    ]);
    expect(rpc.mock.calls[1]?.[1]).toMatchObject({
      p_idempotency_key: input.updateIdempotencyKey,
      p_request_fingerprint: input.updateRequestFingerprint,
      p_recount: false,
    });
    expect(rpc.mock.calls[2]?.[1]).toMatchObject({
      p_idempotency_key: input.postIdempotencyKey,
      p_request_fingerprint: input.postRequestFingerprint,
    });
    expect(result).toEqual({
      stocktake: posted,
      error: null,
      failureStage: null,
      usedLegacyFallback: true,
    });
  });

  it("remembers an explicitly missing atomic RPC per client instead of probing on every completion", async () => {
    const capabilityOwner = {};
    const rpc = vi.fn(async (functionName: string) => {
      if (functionName === "complete_stocktake") {
        return { data: null, error: { code: "PGRST202", message: "Could not find the function public.complete_stocktake in the schema cache" } };
      }
      return { data: functionName === "update_stocktake_draft" ? draft : posted, error: null };
    });

    await completeStocktakeOperation(rpc, input, capabilityOwner);
    rpc.mockClear();
    const result = await completeStocktakeOperation(rpc, input, capabilityOwner);

    expect(rpc.mock.calls.map(([functionName]) => functionName)).toEqual([
      "update_stocktake_draft",
      "post_stocktake",
    ]);
    expect(result).toEqual({ stocktake: posted, error: null, failureStage: null, usedLegacyFallback: true });
  });

  it("falls back to create then POST for a new unsaved count", async () => {
    const rpc = vi.fn(async (functionName: string, _args: Record<string, unknown>) => {
      if (functionName === "complete_stocktake") {
        return { data: null, error: { code: "42883", message: "function complete_stocktake does not exist" } };
      }
      return { data: functionName === "create_stocktake_draft" ? draft : posted, error: null };
    });

    const result = await completeStocktakeOperation(rpc, { ...input, stocktake: null });

    expect(rpc.mock.calls.map(([functionName]) => functionName)).toEqual([
      "complete_stocktake",
      "create_stocktake_draft",
      "post_stocktake",
    ]);
    expect(rpc.mock.calls[1]?.[1]).toMatchObject({
      p_idempotency_key: input.createIdempotencyKey,
      p_request_fingerprint: input.createRequestFingerprint,
    });
    expect(rpc.mock.calls[2]?.[1]).toMatchObject({
      p_stocktake_id: draft.id,
      p_idempotency_key: input.postIdempotencyKey,
      p_request_fingerprint: input.postRequestFingerprint,
    });
    expect(result).toEqual({ stocktake: posted, error: null, failureStage: null, usedLegacyFallback: true });
  });

  it("keeps the saved draft available when the legacy POST fails", async () => {
    const postError = { code: "40001", message: "retry posting" };
    const rpc = vi.fn(async (functionName: string) => {
      if (functionName === "complete_stocktake") {
        return { data: null, error: { code: "PGRST202", message: "Could not find the function public.complete_stocktake in the schema cache" } };
      }
      if (functionName === "update_stocktake_draft") return { data: draft, error: null };
      return { data: null, error: postError };
    });

    const result = await completeStocktakeOperation(rpc, input);

    expect(result).toEqual({
      stocktake: draft,
      error: postError,
      failureStage: "post",
      usedLegacyFallback: true,
    });
  });

  it("preserves a stale-count result for the UI to route into recount", async () => {
    const stale = { ...posted, status: "STALE_COUNT" };
    const rpc = vi.fn(async () => ({ data: stale, error: null }));

    const result = await completeStocktakeOperation(rpc, input);

    expect(result).toEqual({ stocktake: stale, error: null, failureStage: null, usedLegacyFallback: false });
  });

  it("does not fall back after authorization or business errors", async () => {
    const error = { code: "42501", message: "permission denied" };
    const rpc = vi.fn(async () => ({ data: null, error }));

    const result = await completeStocktakeOperation(rpc, input);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      stocktake: null,
      error,
      failureStage: "complete",
      usedLegacyFallback: false,
    });
  });

  it("does not treat an unrelated missing RPC error as a missing completion function", async () => {
    const error = { code: "PGRST202", message: "Could not find some_other_function in schema cache" };
    const rpc = vi.fn(async () => ({ data: null, error }));

    const result = await completeStocktakeOperation(rpc, input);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ stocktake: null, error, failureStage: "complete", usedLegacyFallback: false });
  });

  it("does not start legacy mutations when the atomic response is unknown", async () => {
    const rpc = vi.fn(async () => { throw new Error("untrusted transport details"); });

    const result = await completeStocktakeOperation(rpc, input);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      stocktake: null,
      error: null,
      failureStage: "complete",
      usedLegacyFallback: false,
    });
  });

  it("delegates all mutation work inside the protected SQL transaction", async () => {
    const migration = readFileSync(
      new URL("../../supabase/migrations/0127_atomic_stocktake_completion.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain("create or replace function public.complete_stocktake(");
    expect(migration).toContain("security definer");
    expect(migration).toContain("auth.uid() is null");
    expect(migration).toContain("private.has_role('HR')");
    expect(migration).toContain("private.has_role('WAREHOUSE')");
    const createDraft = migration.indexOf("public.create_stocktake_draft(");
    const updateDraft = migration.indexOf("public.update_stocktake_draft(");
    const postStocktake = migration.indexOf("public.post_stocktake(");
    expect(createDraft).toBeGreaterThan(-1);
    expect(updateDraft).toBeGreaterThan(createDraft);
    expect(postStocktake).toBeGreaterThan(updateDraft);
    expect(migration).toContain("grant execute on function public.complete_stocktake");
    expect(migration).not.toMatch(/insert into public\.(stocktakes|stocktake_lines|inventory_balances|inventory_ledger_entries)/i);
  });
});
