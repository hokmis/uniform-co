export type InventoryRequestInput = {
  hrOnHand: number;
  generalOnHand: number;
  activeReserved: number;
  issueQuantity: number;
  increaseQuantity: number;
};

export type RequestSummary = {
  combinedOnHand: number;
  availableToRequest: number;
  requestedTransfer: number;
  canSubmit: true;
};

export type WarehousePostInput = InventoryRequestInput & {
  actualTransfer: number;
  shortShipReason?: string;
};

export type WarehousePostResult = {
  requestedTransfer: number;
  maximumTransfer: number;
  transferDifference: number;
  hrOnHandAfter: number;
  generalOnHandAfter: number;
  companyOnHandDelta: number;
  shortShipReasonRequired: boolean;
};

export class InventoryRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryRuleError";
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new InventoryRuleError(`${name} must be a non-negative integer`);
  }
}

export function calculateRequestSummary(input: InventoryRequestInput): RequestSummary {
  for (const [name, value] of Object.entries(input)) {
    assertNonNegativeInteger(name, value);
  }

  const combinedOnHand = input.hrOnHand + input.generalOnHand;
  const availableToRequest = combinedOnHand - input.activeReserved;
  const requestedTransfer = input.issueQuantity + input.increaseQuantity;

  if (input.activeReserved > combinedOnHand) {
    throw new InventoryRuleError("active_reserved exceeds combined_on_hand");
  }
  if (requestedTransfer > availableToRequest) {
    throw new InventoryRuleError("requested quantity exceeds available_to_request");
  }

  return {
    combinedOnHand,
    availableToRequest,
    requestedTransfer,
    canSubmit: true,
  };
}

export function calculateWarehousePost(input: WarehousePostInput): WarehousePostResult {
  const { actualTransfer, shortShipReason, ...requestInput } = input;
  const summary = calculateRequestSummary(requestInput);
  assertNonNegativeInteger("actualTransfer", actualTransfer);

  const maximumTransfer = Math.min(summary.requestedTransfer, input.generalOnHand);
  if (actualTransfer > maximumTransfer) {
    throw new InventoryRuleError("actual_transfer exceeds maximum_transfer");
  }

  const hrOnHandAfter = input.hrOnHand + actualTransfer - input.issueQuantity;
  if (hrOnHandAfter < 0) {
    throw new InventoryRuleError("human_resources_warehouse would become negative");
  }

  const shortShipReasonRequired = actualTransfer < maximumTransfer;
  if (shortShipReasonRequired && !shortShipReason?.trim()) {
    throw new InventoryRuleError("short_ship_reason is required");
  }

  return {
    requestedTransfer: summary.requestedTransfer,
    maximumTransfer,
    transferDifference: summary.requestedTransfer - actualTransfer,
    hrOnHandAfter,
    generalOnHandAfter: input.generalOnHand - actualTransfer,
    companyOnHandDelta: -input.issueQuantity,
    shortShipReasonRequired,
  };
}
