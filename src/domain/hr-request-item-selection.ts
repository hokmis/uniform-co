import type { HrRequestLineSelection } from "./hr-request-workflow";

/** Add several uniform items for one employee while preserving existing issue lines. */
export function appendHrRequestItemsForEmployee(
  currentLines: readonly HrRequestLineSelection[],
  employeeId: string,
  selectedItemIds: readonly string[],
  createLineId: () => string,
): HrRequestLineSelection[] {
  if (!employeeId || !selectedItemIds.length) return currentLines.map((line) => ({ ...line }));

  const nextLines = currentLines.map((line) => ({ ...line }));
  const seen = new Set(
    nextLines
      .filter((line) => line.employeeId && line.itemId)
      .map((line) => `${line.employeeId}\u0000${line.itemId}`),
  );

  for (const itemId of selectedItemIds) {
    const key = `${employeeId}\u0000${itemId}`;
    if (!itemId || seen.has(key)) continue;
    seen.add(key);

    const emptyLineIndex = nextLines.findIndex((line) => !line.employeeId && !line.itemId);
    const lineId = emptyLineIndex >= 0 ? nextLines[emptyLineIndex].lineId : createLineId();
    const newLine = { lineId, employeeId, itemId, quantity: 1 };
    if (emptyLineIndex >= 0) nextLines[emptyLineIndex] = newLine;
    else nextLines.push(newLine);
  }

  return nextLines;
}
