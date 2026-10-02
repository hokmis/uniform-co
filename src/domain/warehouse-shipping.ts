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
      if (name === "hrOnHand") {
        if (!Number.isInteger(value as number)) {
          throw new WarehouseShipmentValidationError(`${name} must be an integer`);
        }
      } else {
        assertNonNegativeInteger(name, value as number);
      }
    }
  }

  // 兩階段制服計算：
  // • 階段一：員工領取（即時發生）
  //   • 人事單位：申請領用 +X
  //   • 人事倉庫：發貨扣庫 -X（此時人事倉庫少 X 件，總倉庫存暫時不變）
  // • 階段二：月底總倉補貨（月底結算）
  //   • 總倉：調撥出庫 -X
  //   • 人事倉庫：調撥入庫 +X（此時人事倉庫補回 X 件，總倉實際減少 X 件）
  const requestedTransferQuantity = input.increaseQuantity;
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
