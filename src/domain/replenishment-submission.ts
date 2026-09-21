import { attemptOptionalRpc } from "../lib/optional-rpc";

export type ReplenishmentRpcError = {
  code?: string | null;
  message?: string | null;
};

export type ReplenishmentRpcCall = (
  functionName: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: ReplenishmentRpcError | null }>;

export type ReplenishmentSubmissionLine = { itemId: string; quantity: number };

export type ReplenishmentSubmissionRecord = {
  id: string;
  request_no: string;
  status: "DRAFT" | "SUBMITTED";
};

export type ReplenishmentSubmissionInput = {
  requestId: string | null;
  requestNo: string;
  note: string;
  lines: ReplenishmentSubmissionLine[];
  createIdempotencyKey: string;
  createRequestFingerprint: string;
  updateIdempotencyKey: string;
  updateRequestFingerprint: string;
  submitIdempotencyKey: string;
};

export type ReplenishmentSubmissionResult = {
  request: ReplenishmentSubmissionRecord | null;
  error: ReplenishmentRpcError | null;
  failureStage: "submit" | "create" | "update" | null;
  usedLegacyFallback: boolean;
  outcomeUnknown: boolean;
};

function requestRecord(value: unknown): ReplenishmentSubmissionRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Partial<ReplenishmentSubmissionRecord>;
  if (
    typeof row.id !== "string" || !row.id
    || typeof row.request_no !== "string" || !row.request_no
    || (row.status !== "DRAFT" && row.status !== "SUBMITTED")
  ) return null;
  return { id: row.id, request_no: row.request_no, status: row.status };
}

function normalizedLines(input: ReplenishmentSubmissionInput): ReplenishmentSubmissionLine[] {
  return input.lines.map((line) => ({ itemId: line.itemId, quantity: line.quantity }));
}

function submissionResult(
  request: ReplenishmentSubmissionRecord | null,
  error: ReplenishmentRpcError | null,
  failureStage: ReplenishmentSubmissionResult["failureStage"],
  usedLegacyFallback: boolean,
  outcomeUnknown = false,
): ReplenishmentSubmissionResult {
  return { request, error, failureStage, usedLegacyFallback, outcomeUnknown };
}

/**
 * Submit a new replenishment request or replace and submit an existing draft.
 * New deployments use one database transaction; only an explicit missing-RPC
 * result selects the established idempotent create/update plus submit path.
 */
export async function submitReplenishmentOperation(
  rpc: ReplenishmentRpcCall,
  input: ReplenishmentSubmissionInput,
  capabilityOwner: object = rpc as object,
): Promise<ReplenishmentSubmissionResult> {
  const lines = normalizedLines(input);
  let atomicAttempt: Awaited<ReturnType<typeof attemptOptionalRpc<ReplenishmentRpcError>>>;
  try {
    atomicAttempt = await attemptOptionalRpc(capabilityOwner, rpc, "submit_replenishment_request_with_lines", {
      p_request_id: input.requestId,
      p_request_no: input.requestNo,
      p_note: input.note.trim() || null,
      p_lines: lines,
      p_create_idempotency_key: input.createIdempotencyKey,
      p_create_request_fingerprint: input.createRequestFingerprint,
      p_update_idempotency_key: input.updateIdempotencyKey,
      p_update_request_fingerprint: input.updateRequestFingerprint,
      p_submit_idempotency_key: input.submitIdempotencyKey,
      p_submit_request_fingerprint: JSON.stringify({ requestId: input.requestId, payload: lines }),
    });
  } catch {
    return submissionResult(null, null, "submit", false, true);
  }

  if (atomicAttempt.status === "called") {
    const request = requestRecord(atomicAttempt.data);
    if (atomicAttempt.error) {
      return submissionResult(request, atomicAttempt.error, "submit", false);
    }
    if (request?.status !== "SUBMITTED") {
      return submissionResult(request, null, "submit", false, true);
    }
    return submissionResult(request, null, null, false);
  }
  const usedLegacyFallback = true;

  const update = Boolean(input.requestId);
  const draftFunction = update ? "update_replenishment_request_draft" : "create_replenishment_draft";
  const draftArgs = update
    ? {
      p_request_id: input.requestId,
      p_note: input.note.trim() || null,
      p_lines: lines,
      p_idempotency_key: input.updateIdempotencyKey,
      p_request_fingerprint: input.updateRequestFingerprint,
    }
    : {
      p_request_no: input.requestNo,
      p_note: input.note.trim() || null,
      p_lines: lines,
      p_idempotency_key: input.createIdempotencyKey,
      p_request_fingerprint: input.createRequestFingerprint,
    };

  let draftResult: { data: unknown; error: ReplenishmentRpcError | null };
  try {
    draftResult = await rpc(draftFunction, draftArgs);
  } catch {
    return submissionResult(null, null, update ? "update" : "create", usedLegacyFallback, true);
  }

  const draft = requestRecord(draftResult.data);
  if (draftResult.error || !draft) {
    return submissionResult(
      draft,
      draftResult.error,
      update ? "update" : "create",
      usedLegacyFallback,
      !draftResult.error,
    );
  }
  if (draft.status === "SUBMITTED") {
    return submissionResult(draft, null, null, usedLegacyFallback);
  }

  let submitResult: { data: unknown; error: ReplenishmentRpcError | null };
  try {
    submitResult = await rpc("submit_replenishment_request", {
      p_request_id: draft.id,
      p_idempotency_key: input.submitIdempotencyKey,
      p_request_fingerprint: JSON.stringify({ requestId: draft.id, payload: lines }),
    });
  } catch {
    return submissionResult(draft, null, "submit", usedLegacyFallback, true);
  }

  const submitted = requestRecord(submitResult.data);
  if (submitResult.error || submitted?.status !== "SUBMITTED") {
    return submissionResult(
      draft,
      submitResult.error,
      "submit",
      usedLegacyFallback,
      !submitResult.error,
    );
  }
  return submissionResult(submitted, null, null, usedLegacyFallback);
}
