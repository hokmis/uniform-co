export type PurchaseDecisionInput = {
  approvedQuantity: number;
  minimumOrderQuantity?: number | null;
  finalPurchaseQuantity: number;
  differenceReason?: string;
};

export type PurchaseAllocationInput = {
  currentPurchaseLimit: number;
  existingAllocatedQuantity: number;
  newOrderQuantity: number;
};

export type SeasonalProcurementQueueRow = {
  id: string;
  itemCode: string;
  itemName: string;
  size: string | null;
  approvedQuantity: number;
  decisionStatus: "PENDING" | "DECIDED";
  finalPurchaseQuantity: number | null;
};

export type SeasonalProcurementSortKey = "item_code" | "item_name" | "approved_quantity" | "decision_status";
export type SeasonalProcurementSortDirection = "asc" | "desc";

export function filterSeasonalProcurementQueue(
  rows: readonly SeasonalProcurementQueueRow[],
  query: string,
): SeasonalProcurementQueueRow[] {
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-TW");
  if (!normalizedQuery) return [...rows];
  return rows.filter((row) => [
    row.itemCode,
    row.itemName,
    row.size ?? "",
    row.approvedQuantity,
    row.decisionStatus,
    row.finalPurchaseQuantity ?? "",
  ].join(" ").toLocaleLowerCase("zh-TW").includes(normalizedQuery));
}

export function sortSeasonalProcurementQueue(
  rows: readonly SeasonalProcurementQueueRow[],
  sortKey: SeasonalProcurementSortKey,
  direction: SeasonalProcurementSortDirection,
): SeasonalProcurementQueueRow[] {
  const factor = direction === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => {
    let result = 0;
    if (sortKey === "approved_quantity") result = left.approvedQuantity - right.approvedQuantity;
    else if (sortKey === "decision_status") result = left.decisionStatus.localeCompare(right.decisionStatus, "en");
    else {
      const leftValue = sortKey === "item_name" ? left.itemName : left.itemCode;
      const rightValue = sortKey === "item_name" ? right.itemName : right.itemCode;
      result = leftValue.localeCompare(rightValue, "zh-TW", { numeric: true, sensitivity: "base" });
    }
    return (result || left.id.localeCompare(right.id, "en", { numeric: true })) * factor;
  });
}

export type ReceiptInput = {
  deliveredQuantity: number;
  acceptedQuantity: number;
  rejectedQuantity: number;
  rejectionReason?: string;
};

export type ReceiptProgress = {
  deliveredQuantity: number;
  acceptedQuantity: number;
  rejectedQuantity: number;
  remainingToAccept: number;
};

export class SeasonalProcurementValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeasonalProcurementValidationError";
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new SeasonalProcurementValidationError(`${name} must be a non-negative integer`);
  }
}

export function validatePurchaseDecision(input: PurchaseDecisionInput): void {
  assertNonNegativeInteger("approvedQuantity", input.approvedQuantity);
  assertNonNegativeInteger("finalPurchaseQuantity", input.finalPurchaseQuantity);

  if (input.minimumOrderQuantity !== null && input.minimumOrderQuantity !== undefined) {
    if (!Number.isInteger(input.minimumOrderQuantity) || input.minimumOrderQuantity <= 0) {
      throw new SeasonalProcurementValidationError("minimumOrderQuantity must be a positive integer");
    }
    if (input.finalPurchaseQuantity > 0 && input.finalPurchaseQuantity < input.minimumOrderQuantity) {
      throw new SeasonalProcurementValidationError("finalPurchaseQuantity is below the supplier MOQ");
    }
  }

  if (input.finalPurchaseQuantity !== input.approvedQuantity && !input.differenceReason?.trim()) {
    throw new SeasonalProcurementValidationError("differenceReason is required when purchase quantity differs");
  }
}

export function assertPurchaseAllocationWithinLimit(input: PurchaseAllocationInput): void {
  assertNonNegativeInteger("currentPurchaseLimit", input.currentPurchaseLimit);
  assertNonNegativeInteger("existingAllocatedQuantity", input.existingAllocatedQuantity);
  assertNonNegativeInteger("newOrderQuantity", input.newOrderQuantity);
  if (input.existingAllocatedQuantity + input.newOrderQuantity > input.currentPurchaseLimit) {
    throw new SeasonalProcurementValidationError("purchase allocation exceeds the current purchase limit");
  }
}

export function validateReceipt(input: ReceiptInput): number {
  if (!Number.isInteger(input.deliveredQuantity) || input.deliveredQuantity <= 0) {
    throw new SeasonalProcurementValidationError("deliveredQuantity must be a positive integer");
  }
  assertNonNegativeInteger("acceptedQuantity", input.acceptedQuantity);
  assertNonNegativeInteger("rejectedQuantity", input.rejectedQuantity);
  if (input.acceptedQuantity + input.rejectedQuantity !== input.deliveredQuantity) {
    throw new SeasonalProcurementValidationError("acceptedQuantity + rejectedQuantity must equal deliveredQuantity");
  }
  if (input.rejectedQuantity > 0 && !input.rejectionReason?.trim()) {
    throw new SeasonalProcurementValidationError("rejectionReason is required when rejectedQuantity is positive");
  }
  return input.acceptedQuantity;
}

export function validateReceiptDraft(input: ReceiptInput): void {
  assertNonNegativeInteger("deliveredQuantity", input.deliveredQuantity);
  assertNonNegativeInteger("acceptedQuantity", input.acceptedQuantity);
  assertNonNegativeInteger("rejectedQuantity", input.rejectedQuantity);
}

export function summarizeReceiptProgress(
  orderedQuantity: number,
  postedReceipts: ReceiptInput[],
): ReceiptProgress {
  assertNonNegativeInteger("orderedQuantity", orderedQuantity);
  const totals = postedReceipts.reduce(
    (result, receipt) => {
      validateReceipt(receipt);
      return {
        deliveredQuantity: result.deliveredQuantity + receipt.deliveredQuantity,
        acceptedQuantity: result.acceptedQuantity + receipt.acceptedQuantity,
        rejectedQuantity: result.rejectedQuantity + receipt.rejectedQuantity,
      };
    },
    { deliveredQuantity: 0, acceptedQuantity: 0, rejectedQuantity: 0 },
  );
  if (totals.acceptedQuantity > orderedQuantity) {
    throw new SeasonalProcurementValidationError("accepted receipts exceed ordered quantity");
  }
  return { ...totals, remainingToAccept: orderedQuantity - totals.acceptedQuantity };
}
