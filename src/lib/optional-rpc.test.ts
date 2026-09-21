import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attemptOptionalRpc,
  MISSING_OPTIONAL_RPC_CACHE_TTL_MS,
} from "./optional-rpc";

describe("optional RPC capability cache", () => {
  afterEach(() => vi.useRealTimers());

  it("skips a known-missing function for the same client, then probes again after expiry", async () => {
    vi.useFakeTimers();
    const owner = {};
    const rpc = vi.fn(async () => ({
      data: null,
      error: { code: "PGRST202", message: "Could not find the function public.complete_purchase_receipt in the schema cache" },
    }));

    expect(await attemptOptionalRpc(owner, rpc, "complete_purchase_receipt", {})).toEqual({ status: "missing" });
    expect(await attemptOptionalRpc(owner, rpc, "complete_purchase_receipt", {})).toEqual({ status: "missing" });
    expect(rpc).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(MISSING_OPTIONAL_RPC_CACHE_TTL_MS);
    expect(await attemptOptionalRpc(owner, rpc, "complete_purchase_receipt", {})).toEqual({ status: "missing" });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("does not share missing-function knowledge between database clients", async () => {
    const rpc = vi.fn(async () => ({
      data: null,
      error: { code: "42883", message: "function complete_purchase_receipt does not exist" },
    }));

    await attemptOptionalRpc({}, rpc, "complete_purchase_receipt", {});
    await attemptOptionalRpc({}, rpc, "complete_purchase_receipt", {});

    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("does not cache permission or business errors as a missing capability", async () => {
    const owner = {};
    const rpc = vi.fn(async () => ({
      data: null,
      error: { code: "42501", message: "permission denied" },
    }));

    expect(await attemptOptionalRpc(owner, rpc, "complete_purchase_receipt", {})).toMatchObject({
      status: "called",
      error: { code: "42501" },
    });
    expect(await attemptOptionalRpc(owner, rpc, "complete_purchase_receipt", {})).toMatchObject({
      status: "called",
      error: { code: "42501" },
    });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("does not treat a missing dependency function as the optional function being absent", async () => {
    const owner = {};
    const rpc = vi.fn(async () => ({
      data: null,
      error: { code: "PGRST202", message: "Could not find the function public.some_other_function used by complete_purchase_receipt in the schema cache" },
    }));

    await attemptOptionalRpc(owner, rpc, "complete_purchase_receipt", {});
    await attemptOptionalRpc(owner, rpc, "complete_purchase_receipt", {});

    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("lets unknown transport outcomes escape without converting them into a fallback signal", async () => {
    const owner = {};
    const rpc = vi.fn(async () => { throw new Error("response lost"); });

    await expect(attemptOptionalRpc(owner, rpc, "complete_purchase_receipt", {})).rejects.toThrow("response lost");
    await expect(attemptOptionalRpc(owner, rpc, "complete_purchase_receipt", {})).rejects.toThrow("response lost");
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});
