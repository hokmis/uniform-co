import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readCorrectionInventoryEvidence } from "./correction-ledger-evidence-read";

function queryBuilder(result: unknown) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => result),
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(result).then(resolve, reject),
  };
  return builder;
}

function clientFrom(builders: Record<string, ReturnType<typeof queryBuilder>>): SupabaseClient {
  return {
    from: vi.fn((table: string) => builders[table]),
    auth: { refreshSession: vi.fn() },
  } as unknown as SupabaseClient;
}

describe("correction ledger evidence read", () => {
  it("recovers ledger evidence by correction id when the browser lost its posting idempotency key", async () => {
    const source = queryBuilder({ data: { posting_id: "posting-1" }, error: null });
    const posting = queryBuilder({ data: { id: "posting-1", posting_kind: "CORRECTION" }, error: null });
    const ledger = queryBuilder({
      data: [
        { id: "out-1", posting_id: "posting-1", item_id: "item-1", warehouse_id: "general", movement_kind: "WAREHOUSE_TRANSFER_CORRECTION_OUT", quantity_delta: -4 },
        { id: "in-1", posting_id: "posting-1", item_id: "item-1", warehouse_id: "hr", movement_kind: "WAREHOUSE_TRANSFER_CORRECTION_IN", quantity_delta: 4 },
      ],
      error: null,
    });
    const client = clientFrom({
      correction_posting_sources: source,
      inventory_postings: posting,
      inventory_ledger_entries: ledger,
    });

    await expect(readCorrectionInventoryEvidence(client, "WAREHOUSE_TRANSFER", {
      type: "correction-id",
      value: "correction-1",
    })).resolves.toEqual({ status: "verified" });

    expect(source.eq).toHaveBeenCalledWith("correction_note_id", "correction-1");
    expect(posting.eq).toHaveBeenCalledWith("id", "posting-1");
    expect(ledger.eq).toHaveBeenCalledWith("posting_id", "posting-1");
  });

  it("does not claim evidence when a posted correction has no linked inventory posting", async () => {
    const source = queryBuilder({ data: null, error: null });
    const client = clientFrom({
      correction_posting_sources: source,
      inventory_postings: queryBuilder({ data: null, error: null }),
      inventory_ledger_entries: queryBuilder({ data: [], error: null }),
    });

    await expect(readCorrectionInventoryEvidence(client, "STOCKTAKE", {
      type: "correction-id",
      value: "correction-2",
    })).resolves.toEqual({ status: "missing" });
  });
});
