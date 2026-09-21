import { attemptOptionalRpc } from "../lib/optional-rpc";

export type HrRequestRpcError = {
  code?: string | null;
  message?: string | null;
};

export type HrRequestRpcCall = (
  functionName: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: HrRequestRpcError | null }>;

export type HrRequestSubmissionLine = {
  employeeId: string;
  itemId: string;
  quantity: number;
};

export type HrRequestIncreaseLine = {
  itemId: string;
  quantity: number;
};

export type HrRequestSubmissionRecord = {
  id: string;
  request_no: string;
  status: "DRAFT" | "SUBMITTED" | "INVENTORY_REVIEW_REQUIRED" | "SHIPPED" | "CANCELLED";
};

export type HrRequestSubmissionInput = {
  requestId: string | null;
  requestNo: string;
  distributionDate: string;
  note: string;
  issueLines: HrRequestSubmissionLine[];
  increaseLines: HrRequestIncreaseLine[];
  createIdempotencyKey: string;
  createRequestFingerprint: string;
  updateIdempotencyKey: string;
  updateRequestFingerprint: string;
  submitIdempotencyKey: string;
};

export type HrRequestSubmissionResult = {
  request: HrRequestSubmissionRecord | null;
  error: HrRequestRpcError | null;
  failureStage: "submit" | "create" | "update" | null;
  usedLegacyFallback: boolean;
  outcomeUnknown: boolean;
};

function requestRecord(value: unknown): HrRequestSubmissionRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Partial<HrRequestSubmissionRecord>;
  if (
    typeof row.id !== "string" || !row.id
    || typeof row.request_no !== "string" || !row.request_no
    || (row.status !== "DRAFT" && row.status !== "SUBMITTED"
      && row.status !== "INVENTORY_REVIEW_REQUIRED" && row.status !== "SHIPPED"
      && row.status !== "CANCELLED")
  ) return null;
  return { id: row.id, request_no: row.request_no, status: row.status };
}

function rpcLines(input: HrRequestSubmissionInput) {
  return {
    issueLines: input.issueLines.map((line) => ({
      employeeId: line.employeeId,
      itemId: line.itemId,
      quantity: line.quantity,
    })),
    increaseLines: input.increaseLines
      .filter((line) => line.quantity > 0)
      .map((line) => ({ itemId: line.itemId, quantity: line.quantity })),
  };
}

function legacySubmitFingerprint(
  requestId: string,
  input: HrRequestSubmissionInput,
  issueLines: ReturnType<typeof rpcLines>["issueLines"],
  increaseLines: ReturnType<typeof rpcLines>["increaseLines"],
): string {
  return JSON.stringify({
    requestId,
    issuePayload: issueLines,
    increasePayload: increaseLines,
    distributionDate: input.distributionDate,
    requestNote: input.note.trim(),
  });
}

function atomicSubmitFingerprint(
  input: HrRequestSubmissionInput,
  issueLines: ReturnType<typeof rpcLines>["issueLines"],
  increaseLines: ReturnType<typeof rpcLines>["increaseLines"],
): string {
  return JSON.stringify({
    requestId: input.requestId,
    issuePayload: issueLines,
    increasePayload: increaseLines,
    distributionDate: input.distributionDate,
    requestNote: input.note.trim(),
  });
}

function submissionResult(
  request: HrRequestSubmissionRecord | null,
  error: HrRequestRpcError | null,
  failureStage: HrRequestSubmissionResult["failureStage"],
  usedLegacyFallback: boolean,
  outcomeUnknown = false,
): HrRequestSubmissionResult {
  return { request, error, failureStage, usedLegacyFallback, outcomeUnknown };
}

/**
 * Submit a new HR request or an existing draft in one database transaction
 * where supported. The legacy sequence remains available for older projects,
 * but only an explicit missing-function response may select it. Unknown
 * outcomes retain all operation keys and never start a second write path.
 */
export async function submitHrRequestOperation(
  rpc: HrRequestRpcCall,
  input: HrRequestSubmissionInput,
  capabilityOwner: object = rpc as object,
): Promise<HrRequestSubmissionResult> {
  const { issueLines, increaseLines } = rpcLines(input);
  let atomicAttempt: Awaited<ReturnType<typeof attemptOptionalRpc<HrRequestRpcError>>>;
  try {
    atomicAttempt = await attemptOptionalRpc(capabilityOwner, rpc, "submit_hr_request_with_lines", {
      p_request_id: input.requestId,
      p_request_no: input.requestNo,
      p_distribution_date: input.distributionDate,
      p_note: input.note.trim() || null,
      p_issue_lines: issueLines,
      p_increase_lines: increaseLines,
      p_create_idempotency_key: input.createIdempotencyKey,
      p_create_request_fingerprint: input.createRequestFingerprint,
      p_update_idempotency_key: input.updateIdempotencyKey,
      p_update_request_fingerprint: input.updateRequestFingerprint,
      p_submit_idempotency_key: input.submitIdempotencyKey,
      p_submit_request_fingerprint: atomicSubmitFingerprint(input, issueLines, increaseLines),
  });
  } catch {
    return submissionResult(null, null, "submit", false, true);
  }

  if (atomicAttempt.status === "called") {
    const request = requestRecord(atomicAttempt.data);
    if (atomicAttempt.error || request?.status !== "SUBMITTED") {
      return submissionResult(request, atomicAttempt.error, "submit", false, !atomicAttempt.error);
    }
    return submissionResult(request, null, null, false);
  }
  const usedLegacyFallback = true;

  const update = Boolean(input.requestId);
  const draftFunction = update ? "update_hr_request_draft" : "create_hr_request_draft";
  const draftArgs = update
    ? {
      p_request_id: input.requestId,
      p_distribution_date: input.distributionDate,
      p_note: input.note.trim() || null,
      p_issue_lines: issueLines,
      p_increase_lines: increaseLines,
      p_idempotency_key: input.updateIdempotencyKey,
      p_request_fingerprint: input.updateRequestFingerprint,
    }
    : {
      p_request_no: input.requestNo,
      p_distribution_date: input.distributionDate,
      p_note: input.note.trim() || null,
      p_issue_lines: issueLines,
      p_increase_lines: increaseLines,
      p_idempotency_key: input.createIdempotencyKey,
      p_request_fingerprint: input.createRequestFingerprint,
    };

  let draftResult: { data: unknown; error: HrRequestRpcError | null };
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
  if (draft.status !== "DRAFT") {
    return submissionResult(draft, null, update ? "update" : "create", usedLegacyFallback, true);
  }

  let submitResult: { data: unknown; error: HrRequestRpcError | null };
  try {
    submitResult = await rpc("submit_hr_request", {
      p_request_id: draft.id,
      p_idempotency_key: input.submitIdempotencyKey,
      p_request_fingerprint: legacySubmitFingerprint(draft.id, input, issueLines, increaseLines),
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
