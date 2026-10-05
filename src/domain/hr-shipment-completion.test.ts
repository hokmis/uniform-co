import { describe, expect, it, vi } from "vitest";
import {
  completeHrShipmentOperation,
  parsePendingHrShipmentCompletion,
  type HrShipmentCompletionInput,
  type HrShipmentRpcCall,
} from "./hr-shipment-completion";

const input: HrShipmentCompletionInput = {
  requestId: "hr-request-1",
  expectedRowVersion: 7,
  shipmentNo: "SHIP-20261003-A1B2C3D4",
  lines: [
    { requestItemId: "request-line-1", actualTransferQuantity: 3, shortShipReasonCode: null },
    { requestItemId: "request-line-2", actualTransferQuantity: 1, shortShipReasonCode: "OUT_OF_STOCK" },
  ],
  idempotencyKey: "COMPLETE-HR-SHIPMENT-KEY",
  requestFingerprint: "COMPLETE-HR-SHIPMENT-FINGERPRINT",
};

const posted = {
  id: "shipment-1",
  shipment_no: input.shipmentNo,
  hr_request_id: input.requestId,
  status: "POSTED",
  created_by: "account-1",
};

describe("completeHrShipmentOperation", () => {
  it("completes a new HR shipment with one idempotent RPC using reviewed line values", async () => {
    const rpc = vi.fn(async () => ({ data: posted, error: null }));

    const result = await completeHrShipmentOperation(rpc, input);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("complete_hr_warehouse_shipment_with_lines", {
      p_hr_request_id: input.requestId,
      p_expected_row_version: input.expectedRowVersion,
      p_shipment_no: input.shipmentNo,
      p_lines: [
        { requestItemId: "request-line-1", actualTransferQuantity: 3, shortShipReasonCode: null },
        { requestItemId: "request-line-2", actualTransferQuantity: 1, shortShipReasonCode: "OUT_OF_STOCK" },
      ],
      p_idempotency_key: input.idempotencyKey,
      p_request_fingerprint: input.requestFingerprint,
    });
    expect(result).toEqual({ shipment: posted, error: null, outcomeUnknown: false });
  });

  it("does not treat a draft or another request's shipment as successful completion", async () => {
    const rpc = vi.fn(async () => ({
      data: { ...posted, hr_request_id: "different-request", status: "DRAFT" },
      error: null,
    }));

    const result = await completeHrShipmentOperation(rpc, input);

    expect(result).toEqual({
      shipment: null,
      error: null,
      outcomeUnknown: true,
    });
  });

  it("keeps transport failures unknown and recognizes explicit database validation errors", async () => {
    const gatewayFailure = await completeHrShipmentOperation(async () => ({
      data: null,
      error: { code: "PGRST000", message: "connection lost" },
    }), input);
    const validationFailure = await completeHrShipmentOperation(async () => ({
      data: null,
      error: { code: "23514", message: "validation failed" },
    }), input);

    expect(gatewayFailure.outcomeUnknown).toBe(true);
    expect(validationFailure.outcomeUnknown).toBe(false);
  });

  it("preserves the same idempotency input and marks a lost response unknown", async () => {
    const rpc: HrShipmentRpcCall = vi.fn(async () => {
      throw new TypeError("transport details are not user-facing");
    });

    const result = await completeHrShipmentOperation(rpc, input);

    expect(result).toEqual({ shipment: null, error: null, outcomeUnknown: true });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("complete_hr_warehouse_shipment_with_lines", expect.objectContaining({
      p_idempotency_key: input.idempotencyKey,
      p_request_fingerprint: input.requestFingerprint,
    }));
  });

  it("replays the exact same request after an unknown result and receives the prior completion", async () => {
    const rpc = vi.fn<HrShipmentRpcCall>()
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValueOnce({ data: posted, error: null });

    const first = await completeHrShipmentOperation(rpc, input);
    const second = await completeHrShipmentOperation(rpc, input);

    expect(first.outcomeUnknown).toBe(true);
    expect(second.shipment).toEqual(posted);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1]);
  });
});

describe("pending HR shipment recovery payload", () => {
  it("restores the exact reviewed lines and idempotency identity after a page reload", () => {
    expect(parsePendingHrShipmentCompletion({
      ...input,
      accountId: "account-1",
      requestNo: "REQ-001",
    })).toEqual({
      ...input,
      accountId: "account-1",
      requestNo: "REQ-001",
    });
  });

  it("rejects malformed or out-of-range payloads instead of retrying a different shipment", () => {
    expect(parsePendingHrShipmentCompletion(null)).toBeNull();
    expect(parsePendingHrShipmentCompletion({
      ...input,
      accountId: "account-1",
      requestNo: "REQ-001",
      lines: [{ requestItemId: "request-line-1", actualTransferQuantity: -1, shortShipReasonCode: null }],
    })).toBeNull();
  });
});
