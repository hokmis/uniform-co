import { attemptOptionalRpc } from "../lib/optional-rpc";

export type CorrectionRpcError = {
  code?: string | null;
  message?: string | null;
};

export type CorrectionRpcCall = (
  functionName: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: CorrectionRpcError | null }>;

export type CorrectionCompletionRecord = {
  id: string;
  correction_no: string;
  status: "DRAFT" | "POSTED";
};

export type CorrectionCompletionPlan = {
  atomicFunctionName: string;
  atomicArgs: Record<string, unknown>;
  createFunctionName: string;
  createArgs: Record<string, unknown>;
  postFunctionName: string;
  postArgs: (correctionId: string) => Record<string, unknown>;
};

export type CorrectionCompletionPlanInput = {
  atomicFunctionName: string;
  createFunctionName: string;
  createArgs: Record<string, unknown> & {
    p_idempotency_key: string;
    p_request_fingerprint: string;
  };
  postFunctionName: string;
  postIdempotencyKey: string;
  postRequestFingerprint: string;
  postArgs: (correctionId: string) => Record<string, unknown>;
};

export type CorrectionCompletionResult = {
  correction: CorrectionCompletionRecord | null;
  error: CorrectionRpcError | null;
  failureStage: "complete" | "create" | "post" | null;
  usedLegacyFallback: boolean;
  outcomeUnknown: boolean;
};

/** Stable, non-sensitive fingerprint that can be recreated from the POST key. */
export function correctionPostRequestFingerprint(operationCode: string, idempotencyKey: string): string {
  return JSON.stringify({ operationCode, idempotencyKey });
}

/** Derive the atomic request from the established draft RPC payload. */
export function correctionCompletionPlan(input: CorrectionCompletionPlanInput): CorrectionCompletionPlan {
  const {
    p_idempotency_key: createIdempotencyKey,
    p_request_fingerprint: createRequestFingerprint,
    ...payloadArgs
  } = input.createArgs;
  return {
    atomicFunctionName: input.atomicFunctionName,
    atomicArgs: {
      ...payloadArgs,
      p_create_idempotency_key: createIdempotencyKey,
      p_create_request_fingerprint: createRequestFingerprint,
      p_post_idempotency_key: input.postIdempotencyKey,
      p_post_request_fingerprint: input.postRequestFingerprint,
    },
    createFunctionName: input.createFunctionName,
    createArgs: input.createArgs,
    postFunctionName: input.postFunctionName,
    postArgs: input.postArgs,
  };
}

function correctionRecord(value: unknown): CorrectionCompletionRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Partial<CorrectionCompletionRecord>;
  if (
    typeof row.id !== "string" || row.id.length === 0
    || typeof row.correction_no !== "string" || row.correction_no.length === 0
    || (row.status !== "DRAFT" && row.status !== "POSTED")
  ) return null;
  return row as CorrectionCompletionRecord;
}

function result(
  correction: CorrectionCompletionRecord | null,
  error: CorrectionRpcError | null,
  failureStage: CorrectionCompletionResult["failureStage"],
  usedLegacyFallback: boolean,
  outcomeUnknown = false,
): CorrectionCompletionResult {
  return { correction, error, failureStage, usedLegacyFallback, outcomeUnknown };
}

/**
 * Prefer one database transaction for a new correction. Older schemas use the
 * existing idempotent draft and POST RPCs only after an explicit missing-RPC
 * response; transport loss never starts a second write path.
 */
export async function completeCorrectionOperation(
  rpc: CorrectionRpcCall,
  capabilityOwner: object,
  plan: CorrectionCompletionPlan,
): Promise<CorrectionCompletionResult> {
  let atomicAttempt: Awaited<ReturnType<typeof attemptOptionalRpc<CorrectionRpcError>>>;
  try {
    atomicAttempt = await attemptOptionalRpc(
      capabilityOwner,
      rpc,
      plan.atomicFunctionName,
      plan.atomicArgs,
    );
  } catch {
    return result(null, null, "complete", false, true);
  }

  if (atomicAttempt.status === "called") {
    const correction = correctionRecord(atomicAttempt.data);
    if (atomicAttempt.error) return result(correction, atomicAttempt.error, "complete", false);
    if (correction?.status !== "POSTED") return result(correction, null, "complete", false, true);
    return result(correction, null, null, false);
  }
  const usedLegacyFallback = true;

  let createResult: { data: unknown; error: CorrectionRpcError | null };
  try {
    createResult = await rpc(plan.createFunctionName, plan.createArgs);
  } catch {
    return result(null, null, "create", usedLegacyFallback, true);
  }
  const draft = correctionRecord(createResult.data);
  if (createResult.error || !draft) {
    return result(draft, createResult.error, "create", usedLegacyFallback, !createResult.error);
  }
  if (draft.status === "POSTED") return result(draft, null, null, usedLegacyFallback);

  let postResult: { data: unknown; error: CorrectionRpcError | null };
  try {
    postResult = await rpc(plan.postFunctionName, plan.postArgs(draft.id));
  } catch {
    return result(draft, null, "post", usedLegacyFallback, true);
  }
  const posted = correctionRecord(postResult.data);
  if (postResult.error) return result(draft, postResult.error, "post", usedLegacyFallback);
  if (posted?.status !== "POSTED") return result(draft, null, "post", usedLegacyFallback, true);
  return result(posted, null, null, usedLegacyFallback);
}
