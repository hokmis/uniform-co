import { describe, expect, it, vi } from "vitest";
import {
  completeCorrectionOperation,
  correctionCompletionPlan,
  correctionPostRequestFingerprint,
  type CorrectionCompletionPlan,
  type CorrectionRpcCall,
} from "./correction-completion";

const posted = { id: "correction-1", correction_no: "COR-1", status: "POSTED" as const };
const draft = { id: "correction-1", correction_no: "COR-1", status: "DRAFT" as const };

function plan(): CorrectionCompletionPlan {
  return correctionCompletionPlan({
    atomicFunctionName: "complete_return_correction",
    createFunctionName: "create_return_correction_draft",
    createArgs: { p_idempotency_key: "create-key", p_request_fingerprint: "create-fingerprint" },
    postFunctionName: "post_return_correction",
    postIdempotencyKey: "post-key",
    postRequestFingerprint: "post-fingerprint",
    postArgs: (correctionId) => ({ p_correction_note_id: correctionId, p_idempotency_key: "post-key" }),
  });
}

describe("completeCorrectionOperation", () => {
  it("creates a stable retry fingerprint without copying business form values", () => {
    const fingerprint = correctionPostRequestFingerprint("POST_RETURN_CORRECTION", "POST-RETURN-CORRECTION-key-1");

    expect(fingerprint).toBe(JSON.stringify({
      operationCode: "POST_RETURN_CORRECTION",
      idempotencyKey: "POST-RETURN-CORRECTION-key-1",
    }));
    expect(fingerprint).not.toContain("reason");
  });

  it("derives atomic create arguments from the legacy create contract", () => {
    const completionPlan = correctionCompletionPlan({
      atomicFunctionName: "complete_return_correction",
      createFunctionName: "create_return_correction_draft",
      createArgs: { p_original_return_line_id: "line-1", p_idempotency_key: "create-key", p_request_fingerprint: "create-fingerprint" },
      postFunctionName: "post_return_correction",
      postIdempotencyKey: "post-key",
      postRequestFingerprint: "post-fingerprint",
      postArgs: (correctionId) => ({ p_correction_note_id: correctionId, p_idempotency_key: "post-key" }),
    });

    expect(completionPlan.atomicArgs).toEqual({
      p_original_return_line_id: "line-1",
      p_create_idempotency_key: "create-key",
      p_create_request_fingerprint: "create-fingerprint",
      p_post_idempotency_key: "post-key",
      p_post_request_fingerprint: "post-fingerprint",
    });
    expect(completionPlan.createArgs).toEqual({
      p_original_return_line_id: "line-1",
      p_idempotency_key: "create-key",
      p_request_fingerprint: "create-fingerprint",
    });
  });

  it("completes with exactly one RPC when the atomic function is available", async () => {
    const calls: string[] = [];
    const rpc: CorrectionRpcCall = async (name) => {
      calls.push(name);
      return { data: posted, error: null };
    };

    const result = await completeCorrectionOperation(rpc, {}, plan());

    expect(calls).toEqual(["complete_return_correction"]);
    expect(result).toEqual({ correction: posted, error: null, failureStage: null, usedLegacyFallback: false, outcomeUnknown: false });
  });

  it("uses the existing create-then-post path only when the atomic RPC is missing", async () => {
    const calls: string[] = [];
    const rpc: CorrectionRpcCall = async (name) => {
      calls.push(name);
      if (name === "complete_return_correction") {
        return { data: null, error: { code: "PGRST202", message: "Could not find the function public.complete_return_correction in the schema cache" } };
      }
      return { data: name === "create_return_correction_draft" ? draft : posted, error: null };
    };

    const result = await completeCorrectionOperation(rpc, {}, plan());

    expect(calls).toEqual([
      "complete_return_correction",
      "create_return_correction_draft",
      "post_return_correction",
    ]);
    expect(result).toEqual({ correction: posted, error: null, failureStage: null, usedLegacyFallback: true, outcomeUnknown: false });
  });

  it("does not fall back for authorization or business errors", async () => {
    const calls: string[] = [];
    const error = { code: "42501", message: "role denied" };
    const rpc: CorrectionRpcCall = async (name) => {
      calls.push(name);
      return { data: null, error };
    };

    const result = await completeCorrectionOperation(rpc, {}, plan());

    expect(calls).toEqual(["complete_return_correction"]);
    expect(result).toEqual({ correction: null, error, failureStage: "complete", usedLegacyFallback: false, outcomeUnknown: false });
  });

  it("does not start a second write when the atomic response is unknown", async () => {
    const calls: string[] = [];
    const rpc: CorrectionRpcCall = async (name) => {
      calls.push(name);
      throw new TypeError("connection lost");
    };

    const result = await completeCorrectionOperation(rpc, {}, plan());

    expect(calls).toEqual(["complete_return_correction"]);
    expect(result).toEqual({ correction: null, error: null, failureStage: "complete", usedLegacyFallback: false, outcomeUnknown: true });
  });

  it("returns a known draft when the legacy POST fails, so the UI can retry that draft", async () => {
    const calls: string[] = [];
    const postError = { code: "40001", message: "retry" };
    const rpc: CorrectionRpcCall = async (name) => {
      calls.push(name);
      if (name === "complete_return_correction") {
        return { data: null, error: { code: "42883", message: "function complete_return_correction does not exist" } };
      }
      if (name === "create_return_correction_draft") return { data: draft, error: null };
      return { data: null, error: postError };
    };

    const result = await completeCorrectionOperation(rpc, {}, plan());

    expect(calls).toEqual([
      "complete_return_correction",
      "create_return_correction_draft",
      "post_return_correction",
    ]);
    expect(result).toEqual({ correction: draft, error: postError, failureStage: "post", usedLegacyFallback: true, outcomeUnknown: false });
  });

  it("caches a missing atomic function per client so old databases do not pay a failed probe each time", async () => {
    const owner = {};
    const calls: string[] = [];
    const rpc: CorrectionRpcCall = async (name) => {
      calls.push(name);
      if (name === "complete_return_correction") {
        return { data: null, error: { code: "PGRST202", message: "Could not find the function public.complete_return_correction in the schema cache" } };
      }
      return { data: name === "create_return_correction_draft" ? draft : posted, error: null };
    };

    await completeCorrectionOperation(rpc, owner, plan());
    await completeCorrectionOperation(rpc, owner, plan());

    expect(calls).toEqual([
      "complete_return_correction",
      "create_return_correction_draft",
      "post_return_correction",
      "create_return_correction_draft",
      "post_return_correction",
    ]);
  });

  it("does not treat a different missing function as permission to fall back", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: "PGRST202", message: "create_return_correction_draft is missing" } }));

    const result = await completeCorrectionOperation(rpc, {}, plan());

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(result.failureStage).toBe("complete");
    expect(result.usedLegacyFallback).toBe(false);
  });
});
