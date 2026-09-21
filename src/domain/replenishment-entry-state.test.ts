import { describe, expect, it } from "vitest";
import {
  canCancelReplenishmentEntry,
  canEditReplenishmentEntry,
  markReplenishmentCancellationUnknown,
  resolveReplenishmentCancellationFailure,
  resolveReplenishmentEntryState,
  type ReplenishmentEntryState,
} from "./replenishment-entry-state";

describe("replenishment entry state", () => {
  it("keeps a confirmed draft editable and cancellable", () => {
    const state = resolveReplenishmentEntryState(
      { kind: "new" },
      {
        request: { id: "draft-1", request_no: "REP-001", status: "DRAFT" },
        error: null,
        failureStage: "submit",
        usedLegacyFallback: true,
        outcomeUnknown: false,
      },
    );

    expect(state).toEqual({ kind: "draft", requestId: "draft-1" });
    expect(canEditReplenishmentEntry(state)).toBe(true);
    expect(canCancelReplenishmentEntry(state)).toBe(true);
  });

  it("locks edits and cancellation while preserving the request identity after an unknown result", () => {
    const previous: ReplenishmentEntryState = { kind: "draft", requestId: "draft-1" };
    const state = resolveReplenishmentEntryState(previous, {
      request: null,
      error: null,
      failureStage: "submit",
      usedLegacyFallback: true,
      outcomeUnknown: true,
    });

    expect(state).toEqual({ kind: "submission-unknown", requestId: "draft-1" });
    expect(canEditReplenishmentEntry(state)).toBe(false);
    expect(canCancelReplenishmentEntry(state)).toBe(false);
  });

  it("locks the submitted draft after an unknown cancellation but permits same-reason retry", () => {
    const draft: ReplenishmentEntryState = { kind: "draft", requestId: "draft-1" };
    const pending = markReplenishmentCancellationUnknown(draft, "需求重複");

    expect(pending).toEqual({ kind: "cancellation-unknown", requestId: "draft-1", reason: "需求重複" });
    expect(canEditReplenishmentEntry(pending)).toBe(false);
    expect(canCancelReplenishmentEntry(pending)).toBe(true);
    expect(markReplenishmentCancellationUnknown(pending, "不應替換")).toEqual(pending);
    expect(resolveReplenishmentCancellationFailure(pending)).toEqual({ kind: "draft", requestId: "draft-1" });
  });

  it("keeps an unknown first-create outcome retryable without inventing a request id", () => {
    const state = resolveReplenishmentEntryState({ kind: "new" }, {
      request: null,
      error: null,
      failureStage: "create",
      usedLegacyFallback: true,
      outcomeUnknown: true,
    });

    expect(state).toEqual({ kind: "submission-unknown", requestId: null });
    expect(canEditReplenishmentEntry(state)).toBe(false);
  });

  it("marks a confirmed submission terminal and preserves it when no new result is returned", () => {
    const submitted = resolveReplenishmentEntryState({ kind: "new" }, {
      request: { id: "request-1", request_no: "REP-001", status: "SUBMITTED" },
      error: null,
      failureStage: null,
      usedLegacyFallback: false,
      outcomeUnknown: false,
    });

    expect(submitted).toEqual({ kind: "submitted", requestId: "request-1", requestNo: "REP-001" });
    expect(canEditReplenishmentEntry(submitted)).toBe(false);
    expect(canCancelReplenishmentEntry(submitted)).toBe(false);
    expect(resolveReplenishmentEntryState(submitted, {
      request: null,
      error: { code: "network", message: "unavailable" },
      failureStage: "submit",
      usedLegacyFallback: true,
      outcomeUnknown: false,
    })).toEqual(submitted);
  });
});
