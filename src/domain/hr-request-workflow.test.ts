import { describe, expect, it } from "vitest";
import {
  createHrRequestOperation,
  preserveHrRequestDraftLines,
  preserveHrRequestIncreaseDraft,
  resolveHrRequestSubmissionRoute,
  rotateHrRequestDraftKeys,
  type HrRequestOperation,
} from "./hr-request-workflow";

describe("HR request draft workflow", () => {
  it("keeps the same draft while rotating keys after the payload changes", () => {
    const initial: HrRequestOperation = {
      createKey: "create-1",
      updateKey: "update-1",
      submitKey: "submit-1",
      draftId: "draft-1",
    };

    const rotated = rotateHrRequestDraftKeys(initial, () => "next-key");

    expect(rotated).toEqual({
      createKey: "create-1",
      updateKey: "next-key",
      submitKey: "next-key",
      draftId: "draft-1",
    });
  });

  it("creates independent create, update and submit keys for a new operation", () => {
    const values = ["create-1", "update-1", "submit-1"];
    const operation = createHrRequestOperation(() => values.shift() ?? "unused");

    expect(operation).toEqual({
      createKey: "create-1",
      updateKey: "update-1",
      submitKey: "submit-1",
    });
  });

  it("rotates the create key when a draft id is not known yet", () => {
    const rotated = rotateHrRequestDraftKeys(
      { createKey: "create-1", updateKey: "update-1", submitKey: "submit-1" },
      (() => {
        const values = ["create-2", "update-2", "submit-2"];
        return () => values.shift() ?? "unused";
      })(),
    );

    expect(rotated).toEqual({
      createKey: "create-2",
      updateKey: "update-2",
      submitKey: "submit-2",
    });
  });

  it("routes from one explicit entry state", () => {
    expect(resolveHrRequestSubmissionRoute(null, { kind: "new" })).toEqual({ kind: "new" });
    expect(resolveHrRequestSubmissionRoute("draft-1", { kind: "draft", requestId: "draft-1" })).toEqual({
      kind: "draft",
      requestId: "draft-1",
    });
    expect(resolveHrRequestSubmissionRoute("request-1", {
      kind: "submitted",
      requestId: "request-1",
      editing: true,
    })).toEqual({
      kind: "submitted",
      requestId: "request-1",
    });
  });

  it("fails closed when operation and entry-state identities disagree", () => {
    expect(resolveHrRequestSubmissionRoute(undefined, { kind: "submitted", requestId: "request-1", editing: false })).toEqual({
      kind: "invalid",
      reason: "missing-operation-id",
    });
    expect(resolveHrRequestSubmissionRoute("draft-1", { kind: "submitted", requestId: "request-1", editing: false })).toEqual({
      kind: "invalid",
      reason: "request-id-mismatch",
    });
    expect(resolveHrRequestSubmissionRoute("orphan-id", { kind: "new" })).toEqual({
      kind: "invalid",
      reason: "unexpected-operation-id",
    });
  });

  it("preserves an in-progress draft when master data is refreshed", () => {
    const current = [{ lineId: "line-1", employeeId: "employee-2", itemId: "item-2", quantity: 3 }];
    const fallback = { lineId: "line-default", employeeId: "employee-1", itemId: "item-1", quantity: 1 };

    expect(preserveHrRequestDraftLines(current, fallback)).toEqual(current);
    expect(preserveHrRequestDraftLines([], fallback)).toEqual([fallback]);
    expect(preserveHrRequestIncreaseDraft({ "item-1": 4, "stale-item": 9 }, ["item-1", "item-2"])).toEqual({ "item-1": 4, "item-2": 0 });
  });
});
