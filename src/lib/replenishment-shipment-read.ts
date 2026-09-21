import type { SupabaseClient } from "@supabase/supabase-js";
import { retrySupabaseQueriesAfterSessionRefresh, type SupabaseSessionError } from "./supabase-session";
import { shouldProbeReadModel, shouldUseLegacyReadModel } from "./read-model-rollout";

export type ReplenishmentShipmentLine = {
  id: string;
  request_id: string;
  item_id: string;
  requested_quantity: number;
  item_code_snapshot: string | null;
  item_name_snapshot: string | null;
  unit_snapshot: string | null;
  maximum_transfer_quantity_snapshot: number | null;
  actual_transfer_quantity: number | null;
  short_ship_reason_code: string | null;
  general_on_hand_quantity: number;
  effective_maximum_transfer_quantity: number;
};

export type ReplenishmentShipmentReadResult = {
  data: ReplenishmentShipmentLine[];
  error: SupabaseSessionError | null;
  usedLegacyFallback: boolean;
};

const viewSelect = "id,request_id,item_id,requested_quantity,item_code_snapshot,item_name_snapshot,unit_snapshot,maximum_transfer_quantity_snapshot,actual_transfer_quantity,short_ship_reason_code,general_on_hand_quantity,effective_maximum_transfer_quantity";
const legacyLineSelect = "id,request_id,item_id,requested_quantity,item_code_snapshot,item_name_snapshot,unit_snapshot,maximum_transfer_quantity_snapshot,actual_transfer_quantity,short_ship_reason_code";

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value: unknown): number | null {
  return value == null ? null : numberValue(value);
}

function mapViewRows(rows: unknown[]): ReplenishmentShipmentLine[] {
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    request_id: String(row.request_id),
    item_id: String(row.item_id),
    requested_quantity: numberValue(row.requested_quantity),
    item_code_snapshot: typeof row.item_code_snapshot === "string" ? row.item_code_snapshot : null,
    item_name_snapshot: typeof row.item_name_snapshot === "string" ? row.item_name_snapshot : null,
    unit_snapshot: typeof row.unit_snapshot === "string" ? row.unit_snapshot : null,
    maximum_transfer_quantity_snapshot: nullableNumber(row.maximum_transfer_quantity_snapshot),
    actual_transfer_quantity: nullableNumber(row.actual_transfer_quantity),
    short_ship_reason_code: typeof row.short_ship_reason_code === "string" ? row.short_ship_reason_code : null,
    general_on_hand_quantity: numberValue(row.general_on_hand_quantity),
    effective_maximum_transfer_quantity: numberValue(row.effective_maximum_transfer_quantity),
  }));
}

async function loadLegacyLines(client: SupabaseClient, requestId: string): Promise<ReplenishmentShipmentReadResult> {
  const [lineResult] = await retrySupabaseQueriesAfterSessionRefresh(
    client,
    async () => [await client.from("replenishment_request_lines")
      .select(legacyLineSelect)
      .eq("request_id", requestId)
      .order("item_id")] as const,
  );
  if (lineResult.error) return { data: [], error: lineResult.error, usedLegacyFallback: true };

  const rawLines = (lineResult.data ?? []) as Array<Record<string, unknown>>;
  const itemIds = rawLines.map((line) => String(line.item_id));
  const [availabilityResult] = itemIds.length
    ? await retrySupabaseQueriesAfterSessionRefresh(
      client,
      async () => [await client.from("v_item_availability")
        .select("item_id,general_on_hand_quantity")
        .in("item_id", itemIds)] as const,
    )
    : [{ data: [], error: null }];
  if (availabilityResult.error) return { data: [], error: availabilityResult.error, usedLegacyFallback: true };

  const generalOnHandByItem = new Map(
    ((availabilityResult.data ?? []) as Array<Record<string, unknown>>)
      .map((row) => [String(row.item_id), numberValue(row.general_on_hand_quantity)]),
  );
  const data = rawLines.map((line) => {
    const requestedQuantity = numberValue(line.requested_quantity);
    const generalOnHandQuantity = generalOnHandByItem.get(String(line.item_id)) ?? 0;
    const snapshotMaximum = nullableNumber(line.maximum_transfer_quantity_snapshot);
    return {
      id: String(line.id),
      request_id: String(line.request_id),
      item_id: String(line.item_id),
      requested_quantity: requestedQuantity,
      item_code_snapshot: typeof line.item_code_snapshot === "string" ? line.item_code_snapshot : null,
      item_name_snapshot: typeof line.item_name_snapshot === "string" ? line.item_name_snapshot : null,
      unit_snapshot: typeof line.unit_snapshot === "string" ? line.unit_snapshot : null,
      maximum_transfer_quantity_snapshot: snapshotMaximum,
      actual_transfer_quantity: nullableNumber(line.actual_transfer_quantity),
      short_ship_reason_code: typeof line.short_ship_reason_code === "string" ? line.short_ship_reason_code : null,
      general_on_hand_quantity: generalOnHandQuantity,
      effective_maximum_transfer_quantity: snapshotMaximum ?? Math.min(requestedQuantity, generalOnHandQuantity),
    } satisfies ReplenishmentShipmentLine;
  });
  return { data, error: null, usedLegacyFallback: true };
}

/**
 * Reads submitted replenishment lines through one server-shaped view. The
 * legacy two-read path remains only for rolling deployments where 0117 has
 * not reached the target Supabase project yet.
 */
export async function loadReplenishmentShipmentLines(
  client: SupabaseClient,
  requestId: string,
): Promise<ReplenishmentShipmentReadResult> {
  const viewName = "v_replenishment_shipment_lines";
  if (!shouldProbeReadModel(client, viewName)) return loadLegacyLines(client, requestId);

  const [viewResult] = await retrySupabaseQueriesAfterSessionRefresh(
    client,
    async () => [await client.from("v_replenishment_shipment_lines")
      .select(viewSelect)
      .eq("request_id", requestId)
      .order("item_id")] as const,
  );
  const useLegacyFallback = shouldUseLegacyReadModel(client, viewName, viewResult.error);
  if (!viewResult.error) {
    return { data: mapViewRows(viewResult.data ?? []), error: null, usedLegacyFallback: false };
  }
  if (!useLegacyFallback) {
    return { data: [], error: viewResult.error, usedLegacyFallback: false };
  }
  return loadLegacyLines(client, requestId);
}
