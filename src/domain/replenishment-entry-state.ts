import type { ReplenishmentSubmissionResult } from "./replenishment-submission";

export type ReplenishmentEntryState =
  | { kind: "new" }
  | { kind: "draft"; requestId: string }
  | { kind: "submission-unknown"; requestId: string | null }
  | { kind: "cancellation-unknown"; requestId: string; reason: string }
  | { kind: "submitted"; requestId: string; requestNo: string };

export function resolveReplenishmentEntryState(
  current: ReplenishmentEntryState,
  result: ReplenishmentSubmissionResult,
): ReplenishmentEntryState {
  if (current.kind === "submitted" || current.kind === "cancellation-unknown") return current;
  if (result.failureStage === null && result.request?.status === "SUBMITTED") {
    return {
      kind: "submitted",
      requestId: result.request.id,
      requestNo: result.request.request_no,
    };
  }

  const requestId = result.request?.id
    ?? (current.kind === "draft" || current.kind === "submission-unknown" ? current.requestId : null);
  if (result.outcomeUnknown) return { kind: "submission-unknown", requestId };
  if (result.request?.status === "DRAFT") return { kind: "draft", requestId: result.request.id };
  return current;
}

export function canEditReplenishmentEntry(state: ReplenishmentEntryState): boolean {
  return state.kind === "new" || state.kind === "draft";
}

export function canCancelReplenishmentEntry(state: ReplenishmentEntryState): boolean {
  return state.kind === "draft" || state.kind === "cancellation-unknown";
}

export function markReplenishmentCancellationUnknown(
  state: ReplenishmentEntryState,
  reason: string,
): ReplenishmentEntryState {
  if (state.kind === "cancellation-unknown") return state;
  if (state.kind !== "draft") return state;
  return { kind: "cancellation-unknown", requestId: state.requestId, reason };
}

export function resolveReplenishmentCancellationFailure(
  state: ReplenishmentEntryState,
): ReplenishmentEntryState {
  return state.kind === "cancellation-unknown"
    ? { kind: "draft", requestId: state.requestId }
    : state;
}
