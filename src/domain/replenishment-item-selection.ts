export type ReplenishmentItemLine = { itemId: string; quantity: number };

/** Add checked items to a replenishment draft without replacing edited quantities. */
export function appendReplenishmentItems(
  currentLines: readonly ReplenishmentItemLine[],
  selectedItemIds: readonly string[],
): ReplenishmentItemLine[] {
  const nextLines = currentLines.map((line) => ({ ...line }));
  const seen = new Set(nextLines.map((line) => line.itemId).filter(Boolean));

  for (const itemId of selectedItemIds) {
    if (!itemId || seen.has(itemId)) continue;
    seen.add(itemId);
    const emptyLineIndex = nextLines.findIndex((line) => !line.itemId);
    const addedLine = { itemId, quantity: 1 };
    if (emptyLineIndex >= 0) nextLines[emptyLineIndex] = addedLine;
    else nextLines.push(addedLine);
  }

  return nextLines;
}
