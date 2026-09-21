import { describe, expect, it } from "vitest";
import {
  submitHrRequestOperation,
  type HrRequestRpcCall,
  type HrRequestSubmissionInput,
  type HrRequestSubmissionRecord,
} from "./hr-request-submission";

const submitted: HrRequestSubmissionRecord = {
  id: "request-1",
  request_no: "HR-20260920-001",
  status: "SUBMITTED",
};

function input(requestId: string | null = null): HrRequestSubmissionInput {
  return {
    requestId,
    requestNo: "HR-20260920-001",
    distributionDate: "2026-09-20",
    note: "  測試需求  ",
    issueLines: [{ employeeId: "employee-1", itemId: "item-1", quantity: 2 }],
    increaseLines: [{ itemId: "item-2", quantity: 3 }],
    createIdempotencyKey: "CREATE-create-1",
    createRequestFingerprint: "create-fingerprint",
    updateIdempotencyKey: "UPDATE-update-1",
    updateRequestFingerprint: "update-fingerprint",
    submitIdempotencyKey: "SUBMIT-submit-1",
  };
}

describe("HR request submit latency and retry contract", () => {
  it("uses one serialized client round trip for the common new-request path", async () => {
    const calls: string[] = [];
    let simulatedElapsedMs = 0;
    const rpc: HrRequestRpcCall = async (functionName) => {
      calls.push(functionName);
      // A deterministic 180 ms per remote RPC makes round-trip count the
      // performance assertion; no wall-clock timing or flaky threshold.
      simulatedElapsedMs += 180;
      return { data: submitted, error: null };
    };

    const result = await submitHrRequestOperation(rpc, input());

    expect(result.request).toEqual(submitted);
    expect(result.failureStage).toBeNull();
    expect(calls).toEqual(["submit_hr_request_with_lines"]);
    expect(simulatedElapsedMs).toBe(180);
  });

  it("uses the same one-call path for an existing draft and passes only its identity", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const rpc: HrRequestRpcCall = async (name, args) => {
      calls.push({ name, args });
      return { data: submitted, error: null };
    };

    await submitHrRequestOperation(rpc, input("request-1"));

    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("submit_hr_request_with_lines");
    expect(calls[0].args).toMatchObject({
      p_request_id: "request-1",
      p_update_idempotency_key: "UPDATE-update-1",
      p_submit_idempotency_key: "SUBMIT-submit-1",
    });
  });

  it("falls back only when PostgREST explicitly reports the atomic RPC missing", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const draft: HrRequestSubmissionRecord = {
      id: "request-1",
      request_no: "HR-20260920-001",
      status: "DRAFT",
    };
    const rpc: HrRequestRpcCall = async (name, args) => {
      calls.push({ name, args });
      if (name === "submit_hr_request_with_lines") {
        return {
          data: null,
          error: { code: "PGRST202", message: "Could not find the function public.submit_hr_request_with_lines in the schema cache" },
        };
      }
      return { data: name === "submit_hr_request" ? submitted : draft, error: null };
    };

    const result = await submitHrRequestOperation(rpc, input());

    expect(result.request).toEqual(submitted);
    expect(result.usedLegacyFallback).toBe(true);
    expect(calls.map(({ name }) => name)).toEqual([
      "submit_hr_request_with_lines",
      "create_hr_request_draft",
      "submit_hr_request",
    ]);
    expect(calls[1].args).toMatchObject({
      p_idempotency_key: "CREATE-create-1",
      p_request_fingerprint: "create-fingerprint",
    });
    expect(calls[2].args).toMatchObject({
      p_request_id: "request-1",
      p_idempotency_key: "SUBMIT-submit-1",
    });
  });

  it("skips the unsupported-function probe after the caller caches that capability", async () => {
    const capabilityOwner = {};
    const calls: string[] = [];
    let simulatedElapsedMs = 0;
    const draft: HrRequestSubmissionRecord = {
      id: "request-1",
      request_no: "HR-20260920-001",
      status: "DRAFT",
    };
    const rpc: HrRequestRpcCall = async (name) => {
      calls.push(name);
      simulatedElapsedMs += 180;
      if (name === "submit_hr_request_with_lines") {
        return { data: null, error: { code: "PGRST202", message: "Could not find the function public.submit_hr_request_with_lines in the schema cache" } };
      }
      return { data: name === "submit_hr_request" ? submitted : draft, error: null };
    };

    await submitHrRequestOperation(rpc, input(), capabilityOwner);
    calls.length = 0;
    simulatedElapsedMs = 0;
    const result = await submitHrRequestOperation(rpc, input(), capabilityOwner);

    expect(result.request).toEqual(submitted);
    expect(calls).toEqual(["create_hr_request_draft", "submit_hr_request"]);
    expect(simulatedElapsedMs).toBe(360);
  });

  it("does not start a legacy write after a business error or unknown atomic result", async () => {
    const calls: string[] = [];
    const rpc: HrRequestRpcCall = async (name) => {
      calls.push(name);
      return {
        data: null,
        error: { code: "P0001", message: "Requested quantity exceeds available stock" },
      };
    };

    const result = await submitHrRequestOperation(rpc, input());

    expect(result.request).toBeNull();
    expect(result.usedLegacyFallback).toBe(false);
    expect(result.failureStage).toBe("submit");
    expect(calls).toEqual(["submit_hr_request_with_lines"]);
  });

  it("retries an unknown atomic response with the same arguments and never falls back", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const rpc: HrRequestRpcCall = async (name, args) => {
      calls.push({ name, args });
      throw new Error("simulated response loss");
    };

    const retryInput = input();
    const first = await submitHrRequestOperation(rpc, retryInput);
    const second = await submitHrRequestOperation(rpc, retryInput);

    expect(first.failureStage).toBe("submit");
    expect(second.failureStage).toBe("submit");
    expect(calls.map(({ name }) => name)).toEqual([
      "submit_hr_request_with_lines",
      "submit_hr_request_with_lines",
    ]);
    expect(calls[0].args).toEqual(calls[1].args);
    expect(calls[0].args.p_submit_idempotency_key).toBe("SUBMIT-submit-1");
  });

  it("preserves the recoverable draft when the legacy submit response is unknown", async () => {
    const draft: HrRequestSubmissionRecord = {
      id: "request-1",
      request_no: "HR-20260920-001",
      status: "DRAFT",
    };
    const rpc: HrRequestRpcCall = async (name) => {
      if (name === "submit_hr_request_with_lines") {
        return {
          data: null,
          error: { code: "PGRST202", message: "Could not find the function public.submit_hr_request_with_lines in the schema cache" },
        };
      }
      if (name === "create_hr_request_draft") return { data: draft, error: null };
      return { data: null, error: null };
    };

    const result = await submitHrRequestOperation(rpc, input());

    expect(result.request).toEqual(draft);
    expect(result.failureStage).toBe("submit");
    expect(result.usedLegacyFallback).toBe(true);
    expect(result.outcomeUnknown).toBe(true);
  });

  it("resolves a committed legacy submit by replaying the same create key, without a second request", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const draft: HrRequestSubmissionRecord = {
      id: "request-1",
      request_no: "HR-20260920-001",
      status: "DRAFT",
    };
    let createCount = 0;
    const rpc: HrRequestRpcCall = async (name, args) => {
      calls.push({ name, args });
      if (name === "submit_hr_request_with_lines") {
        return { data: null, error: { code: "PGRST202", message: "Could not find the function public.submit_hr_request_with_lines in the schema cache" } };
      }
      if (name === "create_hr_request_draft") {
        createCount += 1;
        return { data: createCount === 1 ? draft : submitted, error: null };
      }
      return { data: null, error: null };
    };
    const retryInput = input();
    const capabilityOwner = {};

    const first = await submitHrRequestOperation(rpc, retryInput, capabilityOwner);
    const second = await submitHrRequestOperation(rpc, retryInput, capabilityOwner);

    expect(first.outcomeUnknown).toBe(true);
    expect(second.request).toEqual(submitted);
    expect(second.outcomeUnknown).toBe(false);
    expect(calls.map(({ name }) => name)).toEqual([
      "submit_hr_request_with_lines",
      "create_hr_request_draft",
      "submit_hr_request",
      "create_hr_request_draft",
    ]);
    expect(calls[1].args.p_idempotency_key).toBe(calls[3].args.p_idempotency_key);
  });
});
