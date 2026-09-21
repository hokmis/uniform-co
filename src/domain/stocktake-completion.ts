import { attemptOptionalRpc } from "../lib/optional-rpc";

export type StocktakeRpcError = {
  code?: string | null;
  message?: string | null;
};

export type StocktakeRpcCall = (
  functionName: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: StocktakeRpcError | null }>;

export type StocktakeCompletionRecord = {
  id: string;
  stocktake_no: string;
  warehouse_id: string;
  status: "DRAFT" | "STALE_COUNT" | "POSTED";
  note: string | null;
};

export type StocktakeCompletionLine = {
  item_id: string;
  counted_quantity: number;
  reason: string | null;
};

export type StocktakeCompletionInput = {
  stocktake: StocktakeCompletionRecord | null;
  stocktakeNo: string;
  warehouseId: string;
  note: string;
  lines: StocktakeCompletionLine[];
  createIdempotencyKey: string;
  createRequestFingerprint: string;
  updateIdempotencyKey: string;
  updateRequestFingerprint: string;
  postIdempotencyKey: string;
  postRequestFingerprint: string;
};

export type StocktakeCompletionResult = {
  stocktake: StocktakeCompletionRecord | null;
  error: StocktakeRpcError | null;
  failureStage: "complete" | "create" | "update" | "post" | null;
  usedLegacyFallback: boolean;
};

function stocktakeRecord(value: unknown): StocktakeCompletionRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Partial<StocktakeCompletionRecord>;
  if (
    typeof row.id !== "string" || !row.id
    || typeof row.stocktake_no !== "string" || !row.stocktake_no
    || typeof row.warehouse_id !== "string" || !row.warehouse_id
    || (row.status !== "DRAFT" && row.status !== "STALE_COUNT" && row.status !== "POSTED")
    || (row.note !== null && typeof row.note !== "string")
  ) return null;
  return row as StocktakeCompletionRecord;
}

function rpcLines(lines: StocktakeCompletionLine[]) {
  return lines.map((line) => ({
    itemId: line.item_id,
    countedQuantity: line.counted_quantity,
    reason: (line.reason ?? "").trim(),
  }));
}

function completedResult(
  stocktake: StocktakeCompletionRecord | null,
  usedLegacyFallback: boolean,
): StocktakeCompletionResult {
  if (stocktake?.status === "POSTED" || stocktake?.status === "STALE_COUNT") {
    return { stocktake, error: null, failureStage: null, usedLegacyFallback };
  }
  return { stocktake, error: null, failureStage: "complete", usedLegacyFallback };
}

/**
 * Complete a stocktake through one database transaction where available.
 * Legacy databases keep their original create/update then POST path; only an
 * explicit missing-function response enables that fallback. A lost response
 * must keep the same operation keys and must never start a second path.
 */
export async function completeStocktakeOperation(
  rpc: StocktakeRpcCall,
  input: StocktakeCompletionInput,
  capabilityOwner: object = rpc as object,
): Promise<StocktakeCompletionResult> {
  const lines = rpcLines(input.lines);
  let atomicAttempt: Awaited<ReturnType<typeof attemptOptionalRpc<StocktakeRpcError>>>;
  try {
    atomicAttempt = await attemptOptionalRpc(capabilityOwner, rpc, "complete_stocktake", {
      p_stocktake_id: input.stocktake?.id ?? null,
      p_stocktake_no: input.stocktake?.stocktake_no ?? input.stocktakeNo,
      p_warehouse_id: input.stocktake?.warehouse_id ?? input.warehouseId,
      p_note: input.note.trim() || null,
      p_lines: lines,
      p_create_idempotency_key: input.createIdempotencyKey,
      p_create_request_fingerprint: input.createRequestFingerprint,
      p_update_idempotency_key: input.updateIdempotencyKey,
      p_update_request_fingerprint: input.updateRequestFingerprint,
      p_post_idempotency_key: input.postIdempotencyKey,
      p_post_request_fingerprint: input.postRequestFingerprint,
    });
  } catch {
    return { stocktake: null, error: null, failureStage: "complete", usedLegacyFallback: false };
  }

  if (atomicAttempt.status === "called") {
    const atomicStocktake = stocktakeRecord(atomicAttempt.data);
    if (atomicAttempt.error || !atomicStocktake) {
      return {
        stocktake: atomicStocktake,
        error: atomicAttempt.error,
        failureStage: "complete",
        usedLegacyFallback: false,
      };
    }
    return completedResult(atomicStocktake, false);
  }

  let draft: StocktakeCompletionRecord | null;
  const updateOrCreateFunction = input.stocktake ? "update_stocktake_draft" : "create_stocktake_draft";
  const draftArgs = input.stocktake
    ? {
      p_stocktake_id: input.stocktake.id,
      p_note: input.note.trim() || null,
      p_lines: lines,
      p_recount: false,
      p_idempotency_key: input.updateIdempotencyKey,
      p_request_fingerprint: input.updateRequestFingerprint,
    }
    : {
      p_stocktake_no: input.stocktakeNo.trim(),
      p_warehouse_id: input.warehouseId,
      p_note: input.note.trim() || null,
      p_lines: lines,
      p_idempotency_key: input.createIdempotencyKey,
      p_request_fingerprint: input.createRequestFingerprint,
    };

  let draftResult: { data: unknown; error: StocktakeRpcError | null };
  try {
    draftResult = await rpc(updateOrCreateFunction, draftArgs);
  } catch {
    return { stocktake: null, error: null, failureStage: input.stocktake ? "update" : "create", usedLegacyFallback: true };
  }
  draft = stocktakeRecord(draftResult.data);
  if (draftResult.error || !draft) {
    return {
      stocktake: draft,
      error: draftResult.error,
      failureStage: input.stocktake ? "update" : "create",
      usedLegacyFallback: true,
    };
  }
  if (draft.status === "POSTED" || draft.status === "STALE_COUNT") {
    return completedResult(draft, true);
  }

  let postResult: { data: unknown; error: StocktakeRpcError | null };
  try {
    postResult = await rpc("post_stocktake", {
      p_stocktake_id: draft.id,
      p_idempotency_key: input.postIdempotencyKey,
      p_request_fingerprint: input.postRequestFingerprint,
    });
  } catch {
    return { stocktake: draft, error: null, failureStage: "post", usedLegacyFallback: true };
  }
  const postedStocktake = stocktakeRecord(postResult.data);
  if (postResult.error || !postedStocktake || (postedStocktake.status !== "POSTED" && postedStocktake.status !== "STALE_COUNT")) {
    return {
      stocktake: draft,
      error: postResult.error,
      failureStage: "post",
      usedLegacyFallback: true,
    };
  }
  return completedResult(postedStocktake, true);
}
