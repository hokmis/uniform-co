import { describe, expect, it, vi } from "vitest";
import {
  completeReturnOperation,
  type ReturnCompletionInput,
  type ReturnRpcCall,
} from "./return-completion";

const posted = {
  id: "return-1",
  return_no: "RET-001",
  status: "POSTED" as const,
  original_hr_request_id: "request-1",
  return_date: "2026-09-20",
  reason_code: "SIZE",
};

const draft = { ...posted, status: "DRAFT" as const };

function input(): ReturnCompletionInput {
  return {
    returnNo: "RET-001",
    originalHrRequestId: "request-1",
    returnDate: "2026-09-20",
    reasonCode: "SIZE",
    reason: "尺寸不合",
    note: null,
    lines: [{ originalIssueLineId: "issue-line-1", quantity: 1 }],
    createIdempotencyKey: "CREATE-RETURN-V2-create-key",
    createRequestFingerprint: "create-fingerprint",
    postIdempotencyKey: "POST-RETURN-post-key",
    postRequestFingerprint: "post-fingerprint",
  };
}

describe("completeReturnOperation", () => {
  it("uses one RPC for the common create-and-post path", async () => {
    const rpc: ReturnRpcCall = vi.fn(async () => ({ data: posted, error: null }));

    const result = await completeReturnOperation(rpc, {}, input());

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("complete_return_note", {
      p_return_no: "RET-001",
      p_original_hr_request_id: "request-1",
      p_return_date: "2026-09-20",
      p_reason_code: "SIZE",
      p_reason: "尺寸不合",
      p_note: null,
      p_lines: [{ originalIssueLineId: "issue-line-1", quantity: 1 }],
      p_create_idempotency_key: "CREATE-RETURN-V2-create-key",
      p_create_request_fingerprint: "create-fingerprint",
      p_post_idempotency_key: "POST-RETURN-post-key",
      p_post_request_fingerprint: "post-fingerprint",
    });
    expect(result).toEqual({ returnNote: posted, error: null, failureStage: null, usedLegacyFallback: false, outcomeUnknown: false });
  });

  it("uses the existing idempotent draft and post RPCs only when the atomic RPC is missing", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const rpc: ReturnRpcCall = async (name, args) => {
      calls.push({ name, args });
      if (name === "complete_return_note") {
        return { data: null, error: { code: "PGRST202", message: "Could not find the function public.complete_return_note in the schema cache" } };
      }
      return { data: name === "create_return_note_draft" ? draft : posted, error: null };
    };

    const result = await completeReturnOperation(rpc, {}, input());

    expect(calls.map((call) => call.name)).toEqual(["complete_return_note", "create_return_note_draft", "post_return_note"]);
    expect(calls[2]?.args).toEqual({
      p_return_note_id: "return-1",
      p_idempotency_key: "POST-RETURN-post-key",
      p_request_fingerprint: "post-fingerprint",
    });
    expect(result).toEqual({ returnNote: posted, error: null, failureStage: null, usedLegacyFallback: true, outcomeUnknown: false });
  });

  it("never starts a second write after an unknown atomic response", async () => {
    const rpc = vi.fn(async () => { throw new TypeError("connection lost"); });

    const result = await completeReturnOperation(rpc, {}, input());

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("complete_return_note", expect.any(Object));
    expect(result).toEqual({ returnNote: null, error: null, failureStage: "complete", usedLegacyFallback: false, outcomeUnknown: true });
  });

  it("does not fall back for authorization or business errors", async () => {
    const error = { code: "42501", message: "HR role is required" };
    const rpc: ReturnRpcCall = vi.fn(async () => ({ data: null, error }));

    const result = await completeReturnOperation(rpc, {}, input());

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ returnNote: null, error, failureStage: "complete", usedLegacyFallback: false, outcomeUnknown: false });
  });

  it("returns the recoverable draft if the legacy post step fails", async () => {
    const postError = { code: "40001", message: "retry with the same operation" };
    const rpc: ReturnRpcCall = async (name) => {
      if (name === "complete_return_note") {
        return { data: null, error: { code: "42883", message: "function complete_return_note does not exist" } };
      }
      if (name === "create_return_note_draft") return { data: draft, error: null };
      return { data: null, error: postError };
    };

    const result = await completeReturnOperation(rpc, {}, input());

    expect(result).toEqual({ returnNote: draft, error: postError, failureStage: "post", usedLegacyFallback: true, outcomeUnknown: false });
  });

  it("caches an explicitly missing RPC per client without repeating the failed probe", async () => {
    const owner = {};
    const calls: string[] = [];
    const rpc: ReturnRpcCall = async (name) => {
      calls.push(name);
      if (name === "complete_return_note") {
        return { data: null, error: { code: "PGRST202", message: "Could not find the function public.complete_return_note in the schema cache" } };
      }
      return { data: name === "create_return_note_draft" ? draft : posted, error: null };
    };

    await completeReturnOperation(rpc, owner, input());
    await completeReturnOperation(rpc, owner, input());

    expect(calls).toEqual([
      "complete_return_note", "create_return_note_draft", "post_return_note",
      "create_return_note_draft", "post_return_note",
    ]);
  });
});
