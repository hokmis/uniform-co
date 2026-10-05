export type WarehouseShipmentInput = {
  hrOnHand: number;
  generalOnHand: number;
  issueQuantity: number;
  increaseQuantity: number;
  otherActiveReserved: number;
  actualTransfer: number;
  shortShipReason?: string;
};

export type WarehouseShipmentSummary = {
  requestedTransferQuantity: number;
  maximumTransferQuantity: number;
  transferDifference: number;
  hrOnHandAfter: number;
  generalOnHandAfter: number;
  companyOnHandAfter: number;
};

export class WarehouseShipmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WarehouseShipmentValidationError";
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new WarehouseShipmentValidationError(`${name} must be a non-negative integer`);
  }
}

export function calculateWarehouseShipment(
  input: WarehouseShipmentInput,
): WarehouseShipmentSummary {
  for (const [name, value] of Object.entries(input)) {
    if (name !== "shortShipReason") {
      assertNonNegativeInteger(name, value as number);
    }
  }

  // 標準調撥發貨計算：
  // • 總倉調庫需求涵蓋員工領用量（issueQuantity）與隨單增庫量（increaseQuantity）
  // • 由總倉調撥出庫（generalOnHandAfter = generalOnHand - actualTransfer）
  // • 人事倉庫維持常備不扣負（hrOnHandAfter = hrOnHand + actualTransfer - issueQuantity）
  const requestedTransferQuantity = input.issueQuantity + input.increaseQuantity;
  const maximumTransferQuantity = Math.min(requestedTransferQuantity, input.generalOnHand);
  const companyOnHandAfter = input.hrOnHand + input.generalOnHand - input.issueQuantity;

  if (input.actualTransfer > maximumTransferQuantity) {
    throw new WarehouseShipmentValidationError("actual_transfer exceeds maximum_transfer");
  }
  if (input.actualTransfer < maximumTransferQuantity && !input.shortShipReason?.trim()) {
    throw new WarehouseShipmentValidationError("short_ship_reason is required");
  }
  if (companyOnHandAfter < input.otherActiveReserved && companyOnHandAfter >= 0) {
    throw new WarehouseShipmentValidationError("other active reservations would be uncovered");
  }

  return {
    requestedTransferQuantity,
    maximumTransferQuantity,
    transferDifference: requestedTransferQuantity - input.actualTransfer,
    hrOnHandAfter: input.hrOnHand + input.actualTransfer - input.issueQuantity,
    generalOnHandAfter: input.generalOnHand - input.actualTransfer,
    companyOnHandAfter,
  };
}
