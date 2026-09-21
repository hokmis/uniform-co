import { describe, expect, it } from "vitest";
import { kickImportWorkerUntilYielded, maxImportWorkerKickInvocations } from "./import-worker-client";

type WorkerResponse = { data: unknown; error: unknown | null };

function createInvoker(responses: WorkerResponse[]) {
  let calls = 0;
  return {
    get calls() { return calls; },
    invoke: async (_options: { body: { batchId: string } }) => {
      const response = responses[Math.min(calls, responses.length - 1)];
      calls += 1;
      return response;
    },
  };
}

describe("on-demand import worker continuation", () => {
  it("continues while the server confirms more ready work, then returns the final status", async () => {
    const invoker = createInvoker([
      { data: { ok: true, status: "PARSING", continueImmediately: true }, error: null },
      { data: { ok: true, status: "VALIDATING", continueImmediately: true }, error: null },
      { data: { ok: true, status: "VALIDATED", continueImmediately: false }, error: null },
    ]);

    const result = await kickImportWorkerUntilYielded(invoker.invoke, "batch-1");

    expect(result).toEqual({ ok: true, status: "VALIDATED" });
    expect(invoker.calls).toBe(3);
  });

  it("keeps immediate continuation bounded even if the server keeps requesting it", async () => {
    const invoker = createInvoker([
      { data: { ok: true, status: "PARSING", continueImmediately: true }, error: null },
    ]);

    const result = await kickImportWorkerUntilYielded(invoker.invoke, "batch-2");

    expect(result).toEqual({ ok: true, status: "PARSING" });
    expect(invoker.calls).toBe(maxImportWorkerKickInvocations);
  });

  it("yields after a compatible older response that has no continuation field", async () => {
    const invoker = createInvoker([
      { data: { ok: true, status: "PARSING" }, error: null },
    ]);

    const result = await kickImportWorkerUntilYielded(invoker.invoke, "batch-3");

    expect(result).toEqual({ ok: true, status: "PARSING" });
    expect(invoker.calls).toBe(1);
  });

  it("returns a safe failure for invocation errors, malformed responses, and thrown errors", async () => {
    const failed = await kickImportWorkerUntilYielded(
      async () => ({ data: null, error: new Error("sensitive backend details") }),
      "batch-4",
    );
    const malformed = await kickImportWorkerUntilYielded(
      async () => ({ data: { ok: true, status: 42 }, error: null }),
      "batch-5",
    );
    const thrown = await kickImportWorkerUntilYielded(
      async () => { throw new Error("sensitive backend details"); },
      "batch-6",
    );

    expect(failed).toEqual({ ok: false, status: null });
    expect(malformed).toEqual({ ok: false, status: null });
    expect(thrown).toEqual({ ok: false, status: null });
    expect(JSON.stringify([failed, malformed, thrown])).not.toContain("sensitive backend details");
  });
});
