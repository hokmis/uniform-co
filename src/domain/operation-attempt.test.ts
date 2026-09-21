import { describe, expect, it, vi } from "vitest";
import { prepareOperationAttempt } from "./operation-attempt";

describe("idempotent operation attempts", () => {
  it("reuses the key for the same canonical request and rotates it after an edit", () => {
    const createKey = vi.fn(() => "key-2");
    const first = prepareOperationAttempt(null, "request-a", () => "key-1");

    expect(prepareOperationAttempt(first, "request-a", createKey)).toBe(first);
    expect(createKey).not.toHaveBeenCalled();
    expect(prepareOperationAttempt(first, "request-b", createKey)).toEqual({
      key: "key-2",
      fingerprint: "request-b",
    });
    expect(createKey).toHaveBeenCalledOnce();
  });
});
