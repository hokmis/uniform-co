export type StocktakeInput = {
  bookQuantity: number;
  balanceVersion: number;
  capturedBalanceVersion: number;
  countedQuantity: number;
  activeReserved: number;
  reason?: string;
};

export class StocktakeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StocktakeValidationError";
  }
}

export function calculateStocktakeDifference(input: StocktakeInput): number {
  for (const [name, value] of Object.entries(input)) {
    if (name !== "reason") {
      if (!Number.isInteger(value as number) || (value as number) < 0) {
        throw new StocktakeValidationError(`${name} must be a non-negative integer`);
      }
    }
  }
  if (input.balanceVersion !== input.capturedBalanceVersion) {
    throw new StocktakeValidationError("STALE_COUNT");
  }
  const difference = input.countedQuantity - input.bookQuantity;
  if (difference !== 0 && !input.reason?.trim()) {
    throw new StocktakeValidationError("reason is required for a stocktake difference");
  }
  if (input.bookQuantity + difference < input.activeReserved) {
    throw new StocktakeValidationError("stocktake would uncover active reservations");
  }
  return difference;
}
