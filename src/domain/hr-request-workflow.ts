export type HrRequestOperation = {
  createKey: string;
  updateKey: string;
  submitKey: string;
  draftId?: string;
};

export type HrRequestLineSelection = {
  lineId: string;
  employeeId: string;
  itemId: string;
  quantity: number;
};

export type HrRequestEntryState =
  | { kind: "new" }
  | { kind: "draft"; requestId: string }
  | { kind: "submitted"; requestId: string; editing: boolean };

export type HrRequestSubmissionRoute =
  | { kind: "new" }
  | { kind: "draft"; requestId: string }
  | { kind: "submitted"; requestId: string }
  | { kind: "invalid"; reason: "missing-operation-id" | "request-id-mismatch" | "unexpected-operation-id" };

type KeyFactory = () => string;

/**
 * Validate the UI entry state against the request identity held by the
 * idempotency operation. The discriminated state is the single UI status
 * source; mismatched identities fail closed instead of risking a duplicate.
 */
export function resolveHrRequestSubmissionRoute(
  operationRequestId: string | null | undefined,
  entryState: HrRequestEntryState,
): HrRequestSubmissionRoute {
  const operationId = operationRequestId?.trim() ?? "";

  if (entryState.kind === "new") {
    return operationId
      ? { kind: "invalid", reason: "unexpected-operation-id" }
      : { kind: "new" };
  }

  const requestId = entryState.requestId.trim();
  if (!operationId) {
    return { kind: "invalid", reason: "missing-operation-id" };
  }
  if (!requestId || operationId !== requestId) {
    return { kind: "invalid", reason: "request-id-mismatch" };
  }
  return entryState.kind === "draft"
    ? { kind: "draft", requestId }
    : { kind: "submitted", requestId };
}

export function createHrRequestOperation(nextKey: KeyFactory): HrRequestOperation {
  return {
    createKey: nextKey(),
    updateKey: nextKey(),
    submitKey: nextKey(),
  };
}

export function rotateHrRequestDraftKeys(
  operation: HrRequestOperation,
  nextKey: KeyFactory,
): HrRequestOperation {
  return {
    ...operation,
    createKey: operation.draftId ? operation.createKey : nextKey(),
    updateKey: nextKey(),
    submitKey: nextKey(),
  };
}

/**
 * Refreshing master data must not overwrite a draft the user is editing.
 * Only an empty form receives its first suggested line; an existing draft is
 * kept for validation against the refreshed options before submission.
 */
export function preserveHrRequestDraftLines(
  current: readonly HrRequestLineSelection[],
  fallback: HrRequestLineSelection | null,
): HrRequestLineSelection[] {
  return current.length > 0 ? [...current] : fallback ? [fallback] : [];
}

/** Keep entered increase quantities while aligning the map with current items. */
export function preserveHrRequestIncreaseDraft(
  current: Readonly<Record<string, number>>,
  itemIds: readonly string[],
): Record<string, number> {
  return Object.fromEntries(itemIds.map((itemId) => [itemId, current[itemId] ?? 0]));
}
