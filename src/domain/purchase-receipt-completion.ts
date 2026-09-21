import { attemptOptionalRpc } from "../lib/optional-rpc";

export type PurchaseReceiptRpcError = {
  code?: string | null;
  message?: string | null;
};

export type PurchaseReceiptRpcCall = (
  functionName: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: PurchaseReceiptRpcError | null }>;

export type PurchaseReceiptRecord = {
  id: string;
  receipt_no: string;
  purchase_order_id: string;
  status: "DRAFT" | "POSTED";
  received_on: string;
};

export type PurchaseReceiptCompletionInput = {
  receiptNo: string;
  purchaseOrderLineId: string;
  deliveredQuantity: number;
  acceptedQuantity: number;
  rejectedQuantity: number;
  rejectionReason: string | null;
  receivedOn: string;
  createIdempotencyKey: string;
  createRequestFingerprint: string;
  postIdempotencyKey: string;
  postRequestFingerprint: string;
};

export type PurchaseReceiptCompletionResult = {
  receipt: PurchaseReceiptRecord | null;
  error: PurchaseReceiptRpcError | null;
  failureStage: "complete" | "create" | "post" | null;
  usedLegacyFallback: boolean;
};

function receiptRecord(value: unknown): PurchaseReceiptRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as Partial<PurchaseReceiptRecord>;
  if (
    typeof row.id !== "string" || !row.id
    || typeof row.receipt_no !== "string" || !row.receipt_no
    || typeof row.purchase_order_id !== "string" || !row.purchase_order_id
    || (row.status !== "DRAFT" && row.status !== "POSTED")
    || typeof row.received_on !== "string" || !row.received_on
  ) return null;
  return {
    id: row.id,
    receipt_no: row.receipt_no,
    purchase_order_id: row.purchase_order_id,
    status: row.status,
    received_on: row.received_on,
  };
}

function draftArgs(input: PurchaseReceiptCompletionInput) {
  return {
    p_receipt_no: input.receiptNo,
    p_purchase_order_line_id: input.purchaseOrderLineId,
    p_delivered_quantity: input.deliveredQuantity,
    p_accepted_quantity: input.acceptedQuantity,
    p_rejected_quantity: input.rejectedQuantity,
    p_rejection_reason: input.rejectionReason,
    p_received_on: input.receivedOn,
    p_idempotency_key: input.createIdempotencyKey,
    p_request_fingerprint: input.createRequestFingerprint,
  };
}

/**
 * Prefer one transaction/RPC for create-and-post. Until the additive SQL
 * migration is installed, preserve the two existing idempotent RPCs and their
 * recoverable draft boundary. Never fall back for authorization/business errors.
 */
export async function completePurchaseReceipt(
  rpc: PurchaseReceiptRpcCall,
  input: PurchaseReceiptCompletionInput,
  capabilityOwner: object = rpc as object,
): Promise<PurchaseReceiptCompletionResult> {
  let atomicAttempt: Awaited<ReturnType<typeof attemptOptionalRpc<PurchaseReceiptRpcError>>>;
  try {
    atomicAttempt = await attemptOptionalRpc(capabilityOwner, rpc, "complete_purchase_receipt", {
      p_receipt_no: input.receiptNo,
      p_purchase_order_line_id: input.purchaseOrderLineId,
      p_delivered_quantity: input.deliveredQuantity,
      p_accepted_quantity: input.acceptedQuantity,
      p_rejected_quantity: input.rejectedQuantity,
      p_rejection_reason: input.rejectionReason,
      p_received_on: input.receivedOn,
      p_create_idempotency_key: input.createIdempotencyKey,
      p_create_request_fingerprint: input.createRequestFingerprint,
      p_post_idempotency_key: input.postIdempotencyKey,
      p_post_request_fingerprint: input.postRequestFingerprint,
    });
  } catch {
    return { receipt: null, error: null, failureStage: "complete", usedLegacyFallback: false };
  }

  if (atomicAttempt.status === "called") {
    const receipt = receiptRecord(atomicAttempt.data);
    return {
      receipt,
      error: atomicAttempt.error,
      failureStage: atomicAttempt.error || !receipt || receipt.status !== "POSTED" ? "complete" : null,
      usedLegacyFallback: false,
    };
  }
  const usedLegacyFallback = true;

  let createResult: { data: unknown; error: PurchaseReceiptRpcError | null };
  try {
    createResult = await rpc("create_purchase_receipt_draft", draftArgs(input));
  } catch {
    return { receipt: null, error: null, failureStage: "create", usedLegacyFallback: true };
  }
  const createdReceipt = receiptRecord(createResult.data);
  if (createResult.error || !createdReceipt) {
    return {
      receipt: null,
      error: createResult.error,
      failureStage: "create",
      usedLegacyFallback,
    };
  }
  if (createdReceipt.status === "POSTED") {
    return {
      receipt: createdReceipt,
      error: null,
      failureStage: null,
      usedLegacyFallback,
    };
  }

  let postResult: { data: unknown; error: PurchaseReceiptRpcError | null };
  try {
    postResult = await rpc("post_purchase_receipt", {
      p_receipt_id: createdReceipt.id,
      p_idempotency_key: input.postIdempotencyKey,
      p_request_fingerprint: input.postRequestFingerprint,
    });
  } catch {
    return { receipt: createdReceipt, error: null, failureStage: "post", usedLegacyFallback };
  }
  const postedReceipt = receiptRecord(postResult.data);
  if (postResult.error || !postedReceipt || postedReceipt.status !== "POSTED") {
    return {
      receipt: createdReceipt,
      error: postResult.error,
      failureStage: "post",
      usedLegacyFallback,
    };
  }

  return {
    receipt: postedReceipt,
    error: null,
    failureStage: null,
    usedLegacyFallback,
  };
}
