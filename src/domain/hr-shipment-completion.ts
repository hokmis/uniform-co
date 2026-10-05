export type HrShipmentRpcError = {
  code?: string | null;
  message?: string | null;
};

export type HrShipmentRpcCall = (
  functionName: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: HrShipmentRpcError | null }>;

export type HrShipmentCompletionLine = {
  requestItemId: string;
  actualTransferQuantity: number;
  shortShipReasonCode: string | null;
};

export type HrShipmentCompletionInput = {
  requestId: string;
  expectedRowVersion: number;
  shipmentNo: string;
  lines: HrShipmentCompletionLine[];
  idempotencyKey: string;
  requestFingerprint: string;
};

export type PendingHrShipmentCompletion = HrShipmentCompletionInput & {
  accountId: string;
  requestNo: string;
};

export type HrShipmentCompletionRecord = {
  id: string;
  shipment_no: string;
  hr_request_id: string;
  status: "DRAFT" | "POSTED";
  created_by?: string | null;
};

export type HrShipmentCompletionResult = {
  shipment: HrShipmentCompletionRecord | null;
  error: HrShipmentRpcError | null;
  outcomeUnknown: boolean;
};

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Parse persisted recovery data without ever weakening the original payload. */
export function parsePendingHrShipmentCompletion(value: unknown): PendingHrShipmentCompletion | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Partial<PendingHrShipmentCompletion>;
  if (
    !nonEmptyString(row.accountId)
    || !nonEmptyString(row.requestNo)
    || !nonEmptyString(row.requestId)
    || !Number.isSafeInteger(row.expectedRowVersion)
    || (row.expectedRowVersion as number) < 0
    || !nonEmptyString(row.shipmentNo)
    || !nonEmptyString(row.idempotencyKey)
    || !nonEmptyString(row.requestFingerprint)
    || !Array.isArray(row.lines)
    || row.lines.length < 1
    || row.lines.length > 1000
  ) return null;

  const seenRequestItemIds = new Set<string>();
  for (const candidate of row.lines) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return null;
    const line = candidate as Partial<HrShipmentCompletionLine>;
    if (
      !nonEmptyString(line.requestItemId)
      || seenRequestItemIds.has(line.requestItemId)
      || !Number.isSafeInteger(line.actualTransferQuantity)
      || (line.actualTransferQuantity as number) < 0
      || !(line.shortShipReasonCode === null || (
        typeof line.shortShipReasonCode === "string" && line.shortShipReasonCode.length <= 100
      ))
    ) return null;
    seenRequestItemIds.add(line.requestItemId);
  }

  return row as PendingHrShipmentCompletion;
}

function shipmentRecord(value: unknown): HrShipmentCompletionRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Partial<HrShipmentCompletionRecord>;
  if (
    typeof row.id !== "string" || !row.id
    || typeof row.shipment_no !== "string" || !row.shipment_no
    || typeof row.hr_request_id !== "string" || !row.hr_request_id
    || (row.status !== "DRAFT" && row.status !== "POSTED")
    || (row.created_by !== undefined && row.created_by !== null && typeof row.created_by !== "string")
  ) return null;
  return row as HrShipmentCompletionRecord;
}

/**
 * Complete a new HR shipment through one database transaction / PostgREST call.
 * A lost response is unknown, so callers must retain and reuse the same key;
 * this module never starts a legacy create-then-post sequence.
 */
export async function completeHrShipmentOperation(
  rpc: HrShipmentRpcCall,
  input: HrShipmentCompletionInput,
): Promise<HrShipmentCompletionResult> {
  let result: Awaited<ReturnType<HrShipmentRpcCall>>;
  try {
    result = await rpc("complete_hr_warehouse_shipment_with_lines", {
      p_hr_request_id: input.requestId,
      p_expected_row_version: input.expectedRowVersion,
      p_shipment_no: input.shipmentNo,
      p_lines: input.lines,
      p_idempotency_key: input.idempotencyKey,
      p_request_fingerprint: input.requestFingerprint,
    });
  } catch {
    return { shipment: null, error: null, outcomeUnknown: true };
  }

  const shipment = shipmentRecord(result.data);
  if (result.error) {
    const code = result.error.code?.toUpperCase() ?? "";
    const message = result.error.message?.toLowerCase() ?? "";
    const outcomeUnknown = ["PGRST000", "PGRST001", "PGRST002", "PGRST003", "FETCH_ERROR", "ECONNRESET", "ETIMEDOUT"]
      .includes(code)
      || /failed to fetch|networkerror|network request failed|load failed/.test(message);
    return { shipment: null, error: result.error, outcomeUnknown };
  }
  if (!shipment || shipment.hr_request_id !== input.requestId || shipment.status !== "POSTED") {
    return { shipment: null, error: null, outcomeUnknown: true };
  }
  return { shipment, error: null, outcomeUnknown: false };
}
