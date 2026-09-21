import { describe, expect, it } from "vitest";
import {
  submitReplenishmentOperation,
  type ReplenishmentRpcCall,
  type ReplenishmentSubmissionInput,
  type ReplenishmentSubmissionRecord,
} from "./replenishment-submission";

const submitted: ReplenishmentSubmissionRecord = {
  id: "request-1",
  request_no: "REP-20260920-001",
  status: "SUBMITTED",
};

function input(requestId: string | null = null): ReplenishmentSubmissionInput {
  const payload = [{ itemId: "item-1", quantity: 4 }];
  return {
    requestId,
    requestNo: "REP-20260920-001",
    note: "  測試補庫  ",
    lines: payload,
    createIdempotencyKey: "CREATE-create-1",
    createRequestFingerprint: JSON.stringify({ payload, note: "測試補庫" }),
    updateIdempotencyKey: "UPDATE-update-1",
    updateRequestFingerprint: JSON.stringify({ requestId, payload, note: "測試補庫" }),
    submitIdempotencyKey: "SUBMIT-submit-1",
  };
}

describe("replenishment submission latency and retry contract", () => {
  it("uses one serialized RPC for a new request", async () => {
    const calls: string[] = [];
    let simulatedElapsedMs = 0;
    const rpc: ReplenishmentRpcCall = async (name) => {
      calls.push(name);
      simulatedElapsedMs += 180;
      return { data: submitted, error: null };
    };

    const result = await submitReplenishmentOperation(rpc, input());

    expect(result.request).toEqual(submitted);
    expect(result.failureStage).toBeNull();
    expect(calls).toEqual(["submit_replenishment_request_with_lines"]);
    expect(simulatedElapsedMs).toBe(180);
  });

  it("uses the same single-RPC path to update and submit an existing draft", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const rpc: ReplenishmentRpcCall = async (name, args) => {
      calls.push({ name, args });
      return { data: submitted, error: null };
    };

    await submitReplenishmentOperation(rpc, input("request-1"));

    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("submit_replenishment_request_with_lines");
    expect(calls[0].args).toMatchObject({
      p_request_id: "request-1",
      p_update_idempotency_key: "UPDATE-update-1",
      p_submit_idempotency_key: "SUBMIT-submit-1",
    });
  });

  it("falls back to the existing create-and-submit RPCs only when the wrapper is missing", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const draft: ReplenishmentSubmissionRecord = {
      id: "request-1",
      request_no: "REP-20260920-001",
      status: "DRAFT",
    };
    const rpc: ReplenishmentRpcCall = async (name, args) => {
      calls.push({ name, args });
      if (name === "submit_replenishment_request_with_lines") {
        return {
          data: null,
          error: { code: "PGRST202", message: "Could not find the function public.submit_replenishment_request_with_lines in the schema cache" },
        };
      }
      return { data: name === "submit_replenishment_request" ? submitted : draft, error: null };
    };

    const result = await submitReplenishmentOperation(rpc, input());

    expect(result.request).toEqual(submitted);
    expect(result.usedLegacyFallback).toBe(true);
    expect(calls.map(({ name }) => name)).toEqual([
      "submit_replenishment_request_with_lines",
      "create_replenishment_draft",
      "submit_replenishment_request",
    ]);
    expect(calls[1].args).toMatchObject({
      p_idempotency_key: "CREATE-create-1",
      p_request_fingerprint: input().createRequestFingerprint,
    });
    expect(calls[2].args).toMatchObject({
      p_request_id: "request-1",
      p_idempotency_key: "SUBMIT-submit-1",
    });
  });

  it("does not fall back after a known validation error", async () => {
    const calls: string[] = [];
    const rpc: ReplenishmentRpcCall = async (name) => {
      calls.push(name);
      return { data: null, error: { code: "P0001", message: "Replenishment quantity is invalid" } };
    };

    const result = await submitReplenishmentOperation(rpc, input());

    expect(result.failureStage).toBe("submit");
    expect(result.usedLegacyFallback).toBe(false);
    expect(result.outcomeUnknown).toBe(false);
    expect(calls).toEqual(["submit_replenishment_request_with_lines"]);
  });

  it("retries an unknown atomic result with the same idempotency keys and arguments", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const rpc: ReplenishmentRpcCall = async (name, args) => {
      calls.push({ name, args });
      throw new Error("simulated response loss");
    };
    const operation = input();

    const first = await submitReplenishmentOperation(rpc, operation);
    const second = await submitReplenishmentOperation(rpc, operation);

    expect(first.outcomeUnknown).toBe(true);
    expect(second.outcomeUnknown).toBe(true);
    expect(calls.map(({ name }) => name)).toEqual([
      "submit_replenishment_request_with_lines",
      "submit_replenishment_request_with_lines",
    ]);
    expect(calls[0].args).toEqual(calls[1].args);
    expect(calls[0].args.p_submit_idempotency_key).toBe("SUBMIT-submit-1");
  });

  it("skips the missing-function probe after the caller caches legacy support", async () => {
    const capabilityOwner = {};
    const calls: string[] = [];
    const draft: ReplenishmentSubmissionRecord = {
      id: "request-1",
      request_no: "REP-20260920-001",
      status: "DRAFT",
    };
    const rpc: ReplenishmentRpcCall = async (name) => {
      calls.push(name);
      if (name === "submit_replenishment_request_with_lines") {
        return { data: null, error: { code: "PGRST202", message: "Could not find the function public.submit_replenishment_request_with_lines in the schema cache" } };
      }
      return { data: name === "submit_replenishment_request" ? submitted : draft, error: null };
    };

    await submitReplenishmentOperation(rpc, input(), capabilityOwner);
    calls.length = 0;
    const result = await submitReplenishmentOperation(rpc, input(), capabilityOwner);

    expect(result.request).toEqual(submitted);
    expect(calls).toEqual(["create_replenishment_draft", "submit_replenishment_request"]);
  });

  it("updates a recoverable legacy draft before submitting with its stable keys", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const draft: ReplenishmentSubmissionRecord = {
      id: "request-1",
      request_no: "REP-20260920-001",
      status: "DRAFT",
    };
    const rpc: ReplenishmentRpcCall = async (name, args) => {
      calls.push({ name, args });
      if (name === "submit_replenishment_request_with_lines") {
        return { data: null, error: { code: "PGRST202", message: "Could not find the function public.submit_replenishment_request_with_lines in the schema cache" } };
      }
      return { data: name === "submit_replenishment_request" ? submitted : draft, error: null };
    };

    const result = await submitReplenishmentOperation(rpc, input("request-1"));

    expect(result.request).toEqual(submitted);
    expect(calls.map(({ name }) => name)).toEqual([
      "submit_replenishment_request_with_lines",
      "update_replenishment_request_draft",
      "submit_replenishment_request",
    ]);
    expect(calls[1].args).toMatchObject({
      p_request_id: "request-1",
      p_idempotency_key: "UPDATE-update-1",
    });
    expect(calls[2].args.p_idempotency_key).toBe("SUBMIT-submit-1");
  });

  it("returns the recoverable draft when legacy submission cannot be confirmed", async () => {
    const draft: ReplenishmentSubmissionRecord = {
      id: "request-1",
      request_no: "REP-20260920-001",
      status: "DRAFT",
    };
    const rpc: ReplenishmentRpcCall = async (name) => {
      if (name === "submit_replenishment_request_with_lines") {
        return { data: null, error: { code: "PGRST202", message: "Could not find the function public.submit_replenishment_request_with_lines in the schema cache" } };
      }
      if (name === "create_replenishment_draft") return { data: draft, error: null };
      throw new Error("simulated response loss");
    };

    const result = await submitReplenishmentOperation(rpc, input());

    expect(result.request).toEqual(draft);
    expect(result.failureStage).toBe("submit");
    expect(result.usedLegacyFallback).toBe(true);
    expect(result.outcomeUnknown).toBe(true);
  });
});
