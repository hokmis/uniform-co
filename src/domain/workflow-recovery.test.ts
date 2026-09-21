import { describe, expect, it } from "vitest";
import { workflowRecoveryCandidates } from "./workflow-recovery";

describe("workflow recovery candidates", () => {
  it("uses the persisted id before the idempotency key", () => {
    expect(workflowRecoveryCandidates(" artifact-1 ", " request-1 ")).toEqual([
      { kind: "id", value: "artifact-1" },
      { kind: "key", value: "request-1" },
    ]);
  });

  it("does not issue empty recovery lookups", () => {
    expect(workflowRecoveryCandidates("  ", null)).toEqual([]);
  });
});
