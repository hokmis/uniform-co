import type { SupabaseClient } from "@supabase/supabase-js";
import { retrySupabaseQueriesAfterSessionRefresh, type SupabaseSessionError } from "./supabase-session";
import { shouldProbeReadModel, shouldUseLegacyReadModel } from "./read-model-rollout";

export type WarehouseShipmentLineRead = {
  id: string;
  item_id: string;
  hr_request_item_id: string | null;
  item_code_snapshot: string | null;
  item_name_snapshot: string | null;
  unit_snapshot: string | null;
  requested_transfer_quantity_snapshot: number;
  maximum_transfer_quantity_snapshot: number;
  actual_transfer_quantity: number;
  short_ship_reason_code: string | null;
};

export type WarehouseShipmentReadResult = {
  data: WarehouseShipmentLineRead[];
  error: SupabaseSessionError | null;
  usedLegacyFallback: boolean;
};

const viewSelect = "id,item_id,hr_request_item_id,item_code_snapshot,item_name_snapshot,unit_snapshot,requested_transfer_quantity_snapshot,maximum_transfer_quantity_snapshot,actual_transfer_quantity,short_ship_reason_code";
const legacyLineSelect = "id,item_id,hr_request_item_id,requested_transfer_quantity_snapshot,maximum_transfer_quantity_snapshot,actual_transfer_quantity,short_ship_reason_code";
const legacyEmbeddedLineSelect = `${legacyLineSelect},hr_request_item:hr_request_items(item_code_snapshot,item_name_snapshot,unit_snapshot)`;
const legacyItemSelect = "id,item_code_snapshot,item_name_snapshot,unit_snapshot";

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mapRows(rows: unknown[]): WarehouseShipmentLineRead[] {
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    item_id: String(row.item_id),
    hr_request_item_id: typeof row.hr_request_item_id === "string" ? row.hr_request_item_id : null,
    item_code_snapshot: typeof row.item_code_snapshot === "string" ? row.item_code_snapshot : null,
    item_name_snapshot: typeof row.item_name_snapshot === "string" ? row.item_name_snapshot : null,
    unit_snapshot: typeof row.unit_snapshot === "string" ? row.unit_snapshot : null,
    requested_transfer_quantity_snapshot: numberValue(row.requested_transfer_quantity_snapshot),
    maximum_transfer_quantity_snapshot: numberValue(row.maximum_transfer_quantity_snapshot),
    actual_transfer_quantity: numberValue(row.actual_transfer_quantity),
    short_ship_reason_code: typeof row.short_ship_reason_code === "string" ? row.short_ship_reason_code : null,
  }));
}

async function loadLegacyLinesWithSeparateReads(client: SupabaseClient, shipmentId: string, requestId: string): Promise<WarehouseShipmentReadResult> {
  const [lineResult, itemResult] = await retrySupabaseQueriesAfterSessionRefresh(
    client,
    () => Promise.all([
      client.from("warehouse_shipment_lines")
        .select(legacyLineSelect)
        .eq("shipment_id", shipmentId)
        .order("item_id"),
      client.from("hr_request_items")
        .select(legacyItemSelect)
        .eq("request_id", requestId)
        .order("item_id"),
    ]),
  );
  if (lineResult.error || itemResult.error) {
    return { data: [], error: lineResult.error ?? itemResult.error, usedLegacyFallback: true };
  }
  const itemById = new Map(
    ((itemResult.data ?? []) as Array<Record<string, unknown>>).map((item) => [String(item.id), item]),
  );
  const data = ((lineResult.data ?? []) as Array<Record<string, unknown>>).map((line) => {
    const item = itemById.get(String(line.hr_request_item_id));
    return {
      id: String(line.id),
      item_id: String(line.item_id),
      hr_request_item_id: typeof line.hr_request_item_id === "string" ? line.hr_request_item_id : null,
      item_code_snapshot: typeof item?.item_code_snapshot === "string" ? item.item_code_snapshot : null,
      item_name_snapshot: typeof item?.item_name_snapshot === "string" ? item.item_name_snapshot : null,
      unit_snapshot: typeof item?.unit_snapshot === "string" ? item.unit_snapshot : null,
      requested_transfer_quantity_snapshot: numberValue(line.requested_transfer_quantity_snapshot),
      maximum_transfer_quantity_snapshot: numberValue(line.maximum_transfer_quantity_snapshot),
      actual_transfer_quantity: numberValue(line.actual_transfer_quantity),
      short_ship_reason_code: typeof line.short_ship_reason_code === "string" ? line.short_ship_reason_code : null,
    } satisfies WarehouseShipmentLineRead;
  });
  return { data, error: null, usedLegacyFallback: true };
}

async function loadLegacyLines(client: SupabaseClient, shipmentId: string, requestId: string): Promise<WarehouseShipmentReadResult> {
  const [lineResult] = await retrySupabaseQueriesAfterSessionRefresh(
    client,
    async () => [await client.from("warehouse_shipment_lines")
      .select(legacyEmbeddedLineSelect)
      .eq("shipment_id", shipmentId)
      .order("item_id")] as const,
  );
  if (lineResult.error) {
    // Some older PostgREST schema caches cannot resolve this composite FK;
    // keep the original two-query adapter only for that compatibility case.
    if (lineResult.error.code === "PGRST200" || lineResult.error.code === "PGRST201") {
      return loadLegacyLinesWithSeparateReads(client, shipmentId, requestId);
    }
    return { data: [], error: lineResult.error, usedLegacyFallback: true };
  }

  const rows = (lineResult.data ?? []) as Array<Record<string, unknown>>;
  const data = rows.map((line) => {
    const related = line.hr_request_item;
    const item = Array.isArray(related)
      ? related[0] as Record<string, unknown> | undefined
      : typeof related === "object" && related !== null
        ? related as Record<string, unknown>
        : undefined;
    return {
      ...line,
      item_code_snapshot: item?.item_code_snapshot,
      item_name_snapshot: item?.item_name_snapshot,
      unit_snapshot: item?.unit_snapshot,
    };
  });
  return { data: mapRows(data), error: null, usedLegacyFallback: true };
}

/**
 * Reads an HR shipment draft's complete line shape in one request. The legacy
 * embedded foreign-key read is used for projects where 0119 has not been applied;
 * the two-table compatibility path is limited to unavailable relation metadata.
 */
export async function loadWarehouseShipmentLines(
  client: SupabaseClient,
  shipmentId: string,
  requestId: string,
): Promise<WarehouseShipmentReadResult> {
  const viewName = "v_warehouse_shipment_lines";
  if (!shouldProbeReadModel(client, viewName)) return loadLegacyLines(client, shipmentId, requestId);

  const [viewResult] = await retrySupabaseQueriesAfterSessionRefresh(
    client,
    async () => [await client.from("v_warehouse_shipment_lines")
      .select(viewSelect)
      .eq("shipment_id", shipmentId)
      .order("item_id")] as const,
  );
  const useLegacyFallback = shouldUseLegacyReadModel(client, viewName, viewResult.error);
  if (!viewResult.error) return { data: mapRows(viewResult.data ?? []), error: null, usedLegacyFallback: false };
  if (!useLegacyFallback) return { data: [], error: viewResult.error, usedLegacyFallback: false };
  return loadLegacyLines(client, shipmentId, requestId);
}
