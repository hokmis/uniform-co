export type PostedInventoryRecord = {
  id: string;
  status: "POSTED";
};

/** Do not report a stock mutation as complete from an id-only or draft response. */
export function isPostedInventoryRecord(value: unknown, expectedId?: string): value is PostedInventoryRecord {
  if (typeof value !== "object" || value === null) return false;
  const row = value as { id?: unknown; status?: unknown };
  return typeof row.id === "string"
    && row.id.length > 0
    && row.status === "POSTED"
    && (!expectedId || row.id === expectedId);
}
