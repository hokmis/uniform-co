import type { SupabaseClient } from "@supabase/supabase-js";
import { retrySupabaseQueriesAfterSessionRefresh, type SupabaseSessionError } from "./supabase-session";
import { shouldProbeReadModel, shouldUseLegacyReadModel } from "./read-model-rollout";

export type CorrectionHistorySourceKind =
  | "PURCHASE_RECEIPT"
  | "RETURN"
  | "HR_ISSUE"
  | "SHIPMENT"
  | "REPLENISHMENT"
  | "STOCKTAKE";

export type CorrectionHistorySource = {
  kind: CorrectionHistorySourceKind;
  parentId: string;
  lineId: string;
};

export type CorrectionHistoryRow = {
  id: string;
  correction_no: string;
  status: string;
  reason: string;
  posted_at: string | null;
  delta: number;
  delivered_quantity_delta: number;
  accepted_quantity_delta: number;
  rejected_quantity_delta: number;
};

export type CorrectionHistoryReadResult = {
  data: CorrectionHistoryRow[];
  error: SupabaseSessionError | null;
  usedLegacyFallback: boolean;
};

type LegacySpec = {
  correctionKind: "PURCHASE_RECEIPT" | "RETURN" | "HR_ISSUE" | "WAREHOUSE_TRANSFER" | "STOCKTAKE";
  parentColumn: string;
  correctionNoteConstraint: string;
  lineTable: "purchase_receipt_correction_lines" | "return_correction_lines" | "issue_correction_lines" | "warehouse_transfer_correction_lines" | "stocktake_correction_lines";
  lineIdColumn: string;
  lineSelect: string;
  deltaColumn: string;
  deliveredColumn?: string;
  acceptedColumn?: string;
  rejectedColumn?: string;
};

const legacySpecs: Record<CorrectionHistorySourceKind, LegacySpec> = {
  PURCHASE_RECEIPT: {
    correctionKind: "PURCHASE_RECEIPT",
    parentColumn: "original_purchase_receipt_id",
    correctionNoteConstraint: "purchase_receipt_correction_l_correction_note_id_original__fkey",
    lineTable: "purchase_receipt_correction_lines",
    lineIdColumn: "original_receipt_line_id",
    lineSelect: "correction_note_id,original_receipt_line_id,delivered_quantity_delta,accepted_quantity_delta,rejected_quantity_delta",
    deltaColumn: "",
    deliveredColumn: "delivered_quantity_delta",
    acceptedColumn: "accepted_quantity_delta",
    rejectedColumn: "rejected_quantity_delta",
  },
  RETURN: {
    correctionKind: "RETURN",
    parentColumn: "original_return_note_id",
    correctionNoteConstraint: "return_correction_lines_correction_note_id_original_return_fkey",
    lineTable: "return_correction_lines",
    lineIdColumn: "original_return_line_id",
    lineSelect: "correction_note_id,original_return_line_id,return_quantity_delta",
    deltaColumn: "return_quantity_delta",
  },
  HR_ISSUE: {
    correctionKind: "HR_ISSUE",
    parentColumn: "original_hr_request_id",
    correctionNoteConstraint: "issue_correction_lines_correction_note_id_original_hr_requ_fkey",
    lineTable: "issue_correction_lines",
    lineIdColumn: "original_issue_line_id",
    lineSelect: "correction_note_id,original_issue_line_id,issue_quantity_delta",
    deltaColumn: "issue_quantity_delta",
  },
  SHIPMENT: {
    correctionKind: "WAREHOUSE_TRANSFER",
    parentColumn: "original_warehouse_shipment_id",
    correctionNoteConstraint: "warehouse_transfer_correction_correction_note_id_original__fkey",
    lineTable: "warehouse_transfer_correction_lines",
    lineIdColumn: "original_shipment_line_id",
    lineSelect: "correction_note_id,original_shipment_line_id,original_replenishment_line_id,transfer_quantity_delta",
    deltaColumn: "transfer_quantity_delta",
  },
  REPLENISHMENT: {
    correctionKind: "WAREHOUSE_TRANSFER",
    parentColumn: "original_replenishment_request_id",
    correctionNoteConstraint: "warehouse_transfer_correctio_correction_note_id_original__fkey1",
    lineTable: "warehouse_transfer_correction_lines",
    lineIdColumn: "original_replenishment_line_id",
    lineSelect: "correction_note_id,original_shipment_line_id,original_replenishment_line_id,transfer_quantity_delta",
    deltaColumn: "transfer_quantity_delta",
  },
  STOCKTAKE: {
    correctionKind: "STOCKTAKE",
    parentColumn: "original_stocktake_id",
    correctionNoteConstraint: "stocktake_correction_lines_correction_note_id_original_sto_fkey",
    lineTable: "stocktake_correction_lines",
    lineIdColumn: "original_stocktake_line_id",
    lineSelect: "correction_note_id,original_stocktake_line_id,counted_quantity_delta",
    deltaColumn: "counted_quantity_delta",
  },
};

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mapViewRows(rows: unknown[]): CorrectionHistoryRow[] {
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.correction_id),
    correction_no: String(row.correction_no ?? ""),
    status: String(row.status ?? ""),
    reason: String(row.reason ?? ""),
    posted_at: typeof row.posted_at === "string" ? row.posted_at : null,
    delta: numberValue(row.delta_quantity),
    delivered_quantity_delta: numberValue(row.delivered_quantity_delta),
    accepted_quantity_delta: numberValue(row.accepted_quantity_delta),
    rejected_quantity_delta: numberValue(row.rejected_quantity_delta),
  }));
}

function mapLegacyRows(
  notes: Array<Record<string, unknown>>,
  lines: Array<Record<string, unknown>>,
  spec: LegacySpec,
  lineId: string,
): CorrectionHistoryRow[] {
  const lineByNote = new Map(
    lines
      .filter((line) => String(line[spec.lineIdColumn] ?? "") === lineId)
      .map((line) => [String(line.correction_note_id), line]),
  );
  return notes.flatMap((note) => {
    const line = lineByNote.get(String(note.id));
    if (!line) return [];
    return [{
      id: String(note.id),
      correction_no: String(note.correction_no ?? ""),
      status: String(note.status ?? ""),
      reason: String(note.reason ?? ""),
      posted_at: typeof note.posted_at === "string" ? note.posted_at : null,
      delta: numberValue(line[spec.deltaColumn]),
      delivered_quantity_delta: numberValue(spec.deliveredColumn ? line[spec.deliveredColumn] : 0),
      accepted_quantity_delta: numberValue(spec.acceptedColumn ? line[spec.acceptedColumn] : 0),
      rejected_quantity_delta: numberValue(spec.rejectedColumn ? line[spec.rejectedColumn] : 0),
    }];
  });
}

async function loadLegacyHistoryWithSeparateReads(client: SupabaseClient, source: CorrectionHistorySource): Promise<CorrectionHistoryReadResult> {
  const spec = legacySpecs[source.kind];
  const [notesResult] = await retrySupabaseQueriesAfterSessionRefresh(
    client,
    async () => [await client.from("correction_notes")
      .select("id,correction_no,status,reason,posted_at")
      .eq("correction_kind", spec.correctionKind)
      .eq(spec.parentColumn, source.parentId)
      .order("id", { ascending: false })] as const,
  );
  if (notesResult.error) return { data: [], error: notesResult.error, usedLegacyFallback: true };
  const notes = (notesResult.data ?? []) as Array<Record<string, unknown>>;
  if (notes.length === 0) return { data: [], error: null, usedLegacyFallback: true };
  const [linesResult] = await retrySupabaseQueriesAfterSessionRefresh(
    client,
    async () => [await client.from(spec.lineTable)
      .select(spec.lineSelect)
      .in("correction_note_id", notes.map((note) => String(note.id)))] as const,
  );
  if (linesResult.error) return { data: [], error: linesResult.error, usedLegacyFallback: true };
  return {
    data: mapLegacyRows(notes, (linesResult.data ?? []) as unknown as Array<Record<string, unknown>>, spec, source.lineId),
    error: null,
    usedLegacyFallback: true,
  };
}

function mapEmbeddedLegacyRows(
  rows: unknown[],
  spec: LegacySpec,
  lineId: string,
): CorrectionHistoryRow[] {
  const matches = (rows as Array<Record<string, unknown>>).flatMap((line) => {
    const related = line.correction_note;
    const note = Array.isArray(related)
      ? related[0] as Record<string, unknown> | undefined
      : typeof related === "object" && related !== null
        ? related as Record<string, unknown>
        : undefined;
    return note ? [{ line, note }] : [];
  });
  return mapLegacyRows(
    matches.map(({ note }) => note),
    matches.map(({ line }) => line),
    spec,
    lineId,
  );
}

async function loadLegacyHistory(client: SupabaseClient, source: CorrectionHistorySource): Promise<CorrectionHistoryReadResult> {
  const spec = legacySpecs[source.kind];
  const embeddedSelect = `${spec.lineSelect},correction_note:correction_notes!${spec.correctionNoteConstraint}!inner(id,correction_no,status,reason,posted_at,correction_kind,${spec.parentColumn})`;
  const [lineResult] = await retrySupabaseQueriesAfterSessionRefresh(
    client,
    async () => [await client.from(spec.lineTable)
      .select(embeddedSelect)
      .eq(spec.lineIdColumn, source.lineId)
      .eq("correction_note.correction_kind", spec.correctionKind)
      .eq(`correction_note.${spec.parentColumn}`, source.parentId)
      .order("correction_note_id", { ascending: false })] as const,
  );
  if (lineResult.error) {
    // Preserve compatibility with older PostgREST schema caches; permission
    // and unrelated schema errors must remain visible to the caller.
    if (lineResult.error.code === "PGRST200" || lineResult.error.code === "PGRST201") {
      return loadLegacyHistoryWithSeparateReads(client, source);
    }
    return { data: [], error: lineResult.error, usedLegacyFallback: true };
  }
  return {
    data: mapEmbeddedLegacyRows(lineResult.data ?? [], spec, source.lineId),
    error: null,
    usedLegacyFallback: true,
  };
}

/**
 * Read one source line's correction history through the unified view. The
 * source-specific embedded read handles projects where 0116 has not reached
 * the target; separate reads remain only for unavailable relation metadata.
 */
export async function loadCorrectionHistory(client: SupabaseClient, source: CorrectionHistorySource): Promise<CorrectionHistoryReadResult> {
  const viewName = "v_correction_history";
  if (!shouldProbeReadModel(client, viewName)) return loadLegacyHistory(client, source);

  const viewSourceKind = source.kind;
  const correctionKind = source.kind === "SHIPMENT" || source.kind === "REPLENISHMENT" ? "WAREHOUSE_TRANSFER" : source.kind;
  const [viewResult] = await retrySupabaseQueriesAfterSessionRefresh(
    client,
    async () => [await client.from("v_correction_history")
      .select("correction_id,correction_kind,source_kind,correction_no,status,reason,posted_at,source_parent_id,source_line_id,delta_quantity,delivered_quantity_delta,accepted_quantity_delta,rejected_quantity_delta")
      .eq("correction_kind", correctionKind)
      .eq("source_kind", viewSourceKind)
      .eq("source_parent_id", source.parentId)
      .eq("source_line_id", source.lineId)
      .order("correction_id", { ascending: false })] as const,
  );
  const useLegacyFallback = shouldUseLegacyReadModel(client, viewName, viewResult.error);
  if (!viewResult.error) return { data: mapViewRows(viewResult.data ?? []), error: null, usedLegacyFallback: false };
  if (!useLegacyFallback) return { data: [], error: viewResult.error, usedLegacyFallback: false };
  return loadLegacyHistory(client, source);
}
