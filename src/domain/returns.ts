export type ReturnInput = {
  originalIssued: number;
  alreadyReturned: number;
  returnQuantity: number;
};

export class ReturnValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReturnValidationError";
  }
}

export function calculateRemainingIssued(input: ReturnInput): number {
  for (const [name, value] of Object.entries(input)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new ReturnValidationError(`${name} must be a non-negative integer`);
    }
  }
  if (input.alreadyReturned > input.originalIssued) {
    throw new ReturnValidationError("already returned exceeds effective issued");
  }
  const remaining = input.originalIssued - input.alreadyReturned;
  if (input.returnQuantity <= 0 || input.returnQuantity > remaining) {
    throw new ReturnValidationError("return quantity exceeds remaining issued quantity");
  }
  return remaining - input.returnQuantity;
}
