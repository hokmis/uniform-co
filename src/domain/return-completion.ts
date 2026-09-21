import { attemptOptionalRpc } from "../lib/optional-rpc";

export type ReturnRpcError = {
  code?: string | null;
  message?: string | null;
};

export type ReturnRpcCall = (
  functionName: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: ReturnRpcError | null }>;

export type ReturnCompletionRecord = {
  id: string;
  return_no: string;
  status: "DRAFT" | "POSTED";
  original_hr_request_id: string;
  return_date?: string;
  reason_code?: string;
};

export type ReturnCompletionInput = {
  returnNo: string;
  originalHrRequestId: string;
  returnDate: string;
  reasonCode: string;
  reason: string;
  note: string | null;
  lines: Array<{ originalIssueLineId: string; quantity: number }>;
  createIdempotencyKey: string;
  createRequestFingerprint: string;
  postIdempotencyKey: string;
  postRequestFingerprint: string;
};

export type ReturnCompletionResult = {
  returnNote: ReturnCompletionRecord | null;
  error: ReturnRpcError | null;
  failureStage: "complete" | "create" | "post" | null;
  usedLegacyFallback: boolean;
  outcomeUnknown: boolean;
};

function returnRecord(value: unknown): ReturnCompletionRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Partial<ReturnCompletionRecord>;
  if (
    typeof row.id !== "string" || row.id.length === 0
    || typeof row.return_no !== "string" || row.return_no.length === 0
    || (row.status !== "DRAFT" && row.status !== "POSTED")
    || typeof row.original_hr_request_id !== "string" || row.original_hr_request_id.length === 0
  ) return null;
  return {
    id: row.id,
    return_no: row.return_no,
    status: row.status,
    original_hr_request_id: row.original_hr_request_id,
    ...(typeof row.return_date === "string" ? { return_date: row.return_date } : {}),
    ...(typeof row.reason_code === "string" ? { reason_code: row.reason_code } : {}),
  };
}

function result(
  returnNote: ReturnCompletionRecord | null,
  error: ReturnRpcError | null,
  failureStage: ReturnCompletionResult["failureStage"],
  usedLegacyFallback: boolean,
  outcomeUnknown = false,
): ReturnCompletionResult {
  return { returnNote, error, failureStage, usedLegacyFallback, outcomeUnknown };
}

function createArgs(input: ReturnCompletionInput): Record<string, unknown> {
  return {
    p_return_no: input.returnNo,
    p_original_hr_request_id: input.originalHrRequestId,
    p_return_date: input.returnDate,
    p_reason_code: input.reasonCode,
    p_reason: input.reason,
    p_note: input.note,
    p_lines: input.lines,
    p_idempotency_key: input.createIdempotencyKey,
    p_request_fingerprint: input.createRequestFingerprint,
  };
}

/**
 * Prefer one atomic create-and-post RPC. Old database schemas keep using the
 * existing guarded draft/post RPCs, but only after an explicit missing-RPC
 * response; transport loss never starts a second write path.
 */
export async function completeReturnOperation(
  rpc: ReturnRpcCall,
  capabilityOwner: object,
  input: ReturnCompletionInput,
): Promise<ReturnCompletionResult> {
  let atomicAttempt: Awaited<ReturnType<typeof attemptOptionalRpc<ReturnRpcError>>>;
  try {
    atomicAttempt = await attemptOptionalRpc(capabilityOwner, rpc, "complete_return_note", {
      p_return_no: input.returnNo,
      p_original_hr_request_id: input.originalHrRequestId,
      p_return_date: input.returnDate,
      p_reason_code: input.reasonCode,
      p_reason: input.reason,
      p_note: input.note,
      p_lines: input.lines,
      p_create_idempotency_key: input.createIdempotencyKey,
      p_create_request_fingerprint: input.createRequestFingerprint,
      p_post_idempotency_key: input.postIdempotencyKey,
      p_post_request_fingerprint: input.postRequestFingerprint,
    });
  } catch {
    return result(null, null, "complete", false, true);
  }

  if (atomicAttempt.status === "called") {
    const returnNote = returnRecord(atomicAttempt.data);
    if (atomicAttempt.error) return result(returnNote, atomicAttempt.error, "complete", false);
    if (returnNote?.status !== "POSTED") return result(returnNote, null, "complete", false, true);
    return result(returnNote, null, null, false);
  }
  const usedLegacyFallback = true;

  let createResult: { data: unknown; error: ReturnRpcError | null };
  try {
    createResult = await rpc("create_return_note_draft", createArgs(input));
  } catch {
    return result(null, null, "create", usedLegacyFallback, true);
  }

  const draft = returnRecord(createResult.data);
  if (createResult.error || !draft) {
    return result(draft, createResult.error, "create", usedLegacyFallback, !createResult.error);
  }
  if (draft.status === "POSTED") return result(draft, null, null, usedLegacyFallback);
  if (draft.status !== "DRAFT") return result(draft, null, "create", usedLegacyFallback, true);

  let postResult: { data: unknown; error: ReturnRpcError | null };
  try {
    postResult = await rpc("post_return_note", {
      p_return_note_id: draft.id,
      p_idempotency_key: input.postIdempotencyKey,
      p_request_fingerprint: input.postRequestFingerprint,
    });
  } catch {
    return result(draft, null, "post", usedLegacyFallback, true);
  }

  const posted = returnRecord(postResult.data);
  if (postResult.error) return result(draft, postResult.error, "post", usedLegacyFallback);
  if (posted?.status !== "POSTED") return result(draft, null, "post", usedLegacyFallback, true);
  return result(posted, null, null, usedLegacyFallback);
}
