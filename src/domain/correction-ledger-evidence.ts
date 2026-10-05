export type CorrectionLedgerEvidenceRow = {
  ledger_entry_id?: unknown;
  posting_id?: unknown;
  item_id?: unknown;
  warehouse_id?: unknown;
  posting_kind?: unknown;
  movement_kind?: unknown;
  quantity_delta?: unknown;
};

export type CorrectionLedgerEvidenceStatus = "verified" | "missing" | "mismatch";

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function safeInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function hasSharedPosting(rows: CorrectionLedgerEvidenceRow[]): boolean {
  const first = rows[0];
  return nonEmptyString(first?.posting_id)
    && nonEmptyString(first?.item_id)
    && rows.every((row) => row.posting_id === first.posting_id
      && row.item_id === first.item_id
      && row.posting_kind === "CORRECTION"
      && nonEmptyString(row.ledger_entry_id))
    && new Set(rows.map((row) => row.ledger_entry_id)).size === rows.length;
}

/**
 * Check the persisted ledger rows for a correction's unique posting key.
 * Transfer corrections intentionally net to zero overall, but must contain
 * one GENERAL and one HR movement. Stocktake corrections must contain one
 * non-zero movement in the source warehouse.
 */
export function verifyCorrectionLedgerEvidence(
  kind: "WAREHOUSE_TRANSFER" | "STOCKTAKE",
  rows: CorrectionLedgerEvidenceRow[],
): CorrectionLedgerEvidenceStatus {
  if (rows.length === 0) return "missing";
  if (!hasSharedPosting(rows)) return "mismatch";

  if (kind === "WAREHOUSE_TRANSFER") {
    if (rows.length < 2) return "missing";
    if (rows.length !== 2) return "mismatch";
    const outbound = rows.find((row) => row.movement_kind === "WAREHOUSE_TRANSFER_CORRECTION_OUT");
    const inbound = rows.find((row) => row.movement_kind === "WAREHOUSE_TRANSFER_CORRECTION_IN");
    const outboundDelta = safeInteger(outbound?.quantity_delta);
    const inboundDelta = safeInteger(inbound?.quantity_delta);
    if (!nonEmptyString(outbound?.warehouse_id) || !nonEmptyString(inbound?.warehouse_id)
      || outbound.warehouse_id === inbound.warehouse_id
      || outboundDelta === null || inboundDelta === null
      || outboundDelta === 0 || inboundDelta === 0) return "mismatch";
    return outboundDelta + inboundDelta === 0 ? "verified" : "mismatch";
  }

  if (rows.length !== 1) return "mismatch";
  const [row] = rows;
  const delta = safeInteger(row.quantity_delta);
  return row.movement_kind === "STOCKTAKE_CORRECTION"
    && nonEmptyString(row.warehouse_id)
    && delta !== null && delta !== 0
    ? "verified"
    : "mismatch";
}
