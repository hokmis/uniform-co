import { describe, expect, it, vi } from "vitest";
import {
  classifyMasterImportOutcome,
  prepareMasterImportAttempt,
  type MasterImportAttemptIdentity,
} from "./master-data-import";

const identity: MasterImportAttemptIdentity = {
  entityType: "UNIFORM_ITEMS",
  sourceFilename: "items.csv",
  payloadSha256: "a".repeat(64),
};

describe("master-data import operation", () => {
  it("reuses the same idempotency key only for an identical parsed payload", () => {
    const createKey = vi.fn(() => "attempt-2");
    const first = prepareMasterImportAttempt(null, identity, () => "attempt-1");

    expect(prepareMasterImportAttempt(first, identity, createKey)).toBe(first);
    expect(createKey).not.toHaveBeenCalled();

    const changed = prepareMasterImportAttempt(first, { ...identity, payloadSha256: "b".repeat(64) }, createKey);
    expect(changed).toMatchObject({ idempotencyKey: "attempt-2", payloadSha256: "b".repeat(64) });
    expect(createKey).toHaveBeenCalledOnce();
  });

  it("distinguishes applied, rejected, and unresolved database outcomes", () => {
    expect(classifyMasterImportOutcome({ status: "APPLIED", row_count: 8 }, null)).toEqual({
      kind: "applied",
      rowCount: 8,
    });
    expect(classifyMasterImportOutcome([{ status: "FAILED", row_count: 8, error_count: 2 }], null)).toEqual({
      kind: "rejected",
      rowCount: 8,
      errorCount: 2,
    });
    expect(classifyMasterImportOutcome(null, { code: "network" })).toEqual({ kind: "unknown" });
    expect(classifyMasterImportOutcome({ status: "PROCESSING" }, null)).toEqual({ kind: "unknown" });
  });
});
