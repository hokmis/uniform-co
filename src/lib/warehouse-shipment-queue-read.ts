import type { SupabaseClient } from "@supabase/supabase-js";
import { retrySupabaseQueriesAfterSessionRefresh, type SupabaseSessionError } from "./supabase-session";
import { shouldProbeReadModel, shouldUseLegacyReadModel } from "./read-model-rollout";

export type WarehouseShipmentQueueReadRow = {
  queue_key: string;
  id: string;
  source: "HR_REQUEST" | "REPLENISHMENT";
  request_no: string;
  distribution_date: string;
  row_version: number;
  shipment_id: string | null;
  shipment_no: string | null;
  shipment_status: "DRAFT" | "POSTED" | null;
  shipment_created_by: string | null;
};

export type WarehouseShipmentQueueReadResult = {
  data: WarehouseShipmentQueueReadRow[];
  error: SupabaseSessionError | null;
  usedLegacyFallback: boolean;
};

const viewSelect = "queue_key,id,source,request_no,distribution_date,row_version,shipment_id,shipment_no,shipment_status,shipment_created_by";
const hrRequestSelect = "id,request_no,distribution_date,row_version";
const embeddedHrRequestSelect = `${hrRequestSelect},draft_shipment:warehouse_shipments!warehouse_shipments_hr_request_id_fkey(id,shipment_no,status,created_by)`;
const shipmentSelect = "hr_request_id,id,shipment_no,status,created_by";
const replenishmentSelect = "id,request_no,submitted_at,created_at,row_version";

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function relatedObject(value: unknown): Record<string, unknown> | undefined {
  const row = Array.isArray(value) ? value[0] : value;
  return typeof row === "object" && row !== null ? row as Record<string, unknown> : undefined;
}

function mapViewRows(rows: unknown[]): WarehouseShipmentQueueReadRow[] {
  return (rows as Array<Record<string, unknown>>).flatMap((row) => {
    if (row.source !== "HR_REQUEST" && row.source !== "REPLENISHMENT") return [];
    const source = row.source;
    const id = stringValue(row.id);
    if (!id) return [];
    return [{
      queue_key: stringValue(row.queue_key) || `${source}:${id}`,
      id,
      source,
      request_no: stringValue(row.request_no),
      distribution_date: stringValue(row.distribution_date),
      row_version: numberValue(row.row_version),
      shipment_id: typeof row.shipment_id === "string" ? row.shipment_id : null,
      shipment_no: typeof row.shipment_no === "string" ? row.shipment_no : null,
      shipment_status: row.shipment_status === "DRAFT" || row.shipment_status === "POSTED" ? row.shipment_status : null,
      shipment_created_by: typeof row.shipment_created_by === "string" ? row.shipment_created_by : null,
    }];
  });
}

function mapHrRequests(
  rows: unknown[],
  shipmentByRequestId: ReadonlyMap<string, Record<string, unknown>> = new Map(),
  embedded = false,
): WarehouseShipmentQueueReadRow[] {
  return (rows as Array<Record<string, unknown>>).flatMap((row) => {
    const id = stringValue(row.id);
    if (!id) return [];
    const shipment = embedded
      ? relatedObject(row.draft_shipment)
      : shipmentByRequestId.get(id);
    const isDraft = shipment?.status === "DRAFT";
    return [{
      queue_key: `HR_REQUEST:${id}`,
      id,
      source: "HR_REQUEST",
      request_no: stringValue(row.request_no),
      distribution_date: stringValue(row.distribution_date),
      row_version: numberValue(row.row_version),
      shipment_id: isDraft && typeof shipment?.id === "string" ? shipment.id : null,
      shipment_no: isDraft && typeof shipment?.shipment_no === "string" ? shipment.shipment_no : null,
      shipment_status: isDraft ? "DRAFT" : null,
      shipment_created_by: isDraft && typeof shipment?.created_by === "string" ? shipment.created_by : null,
    }];
  });
}

function mapReplenishments(rows: unknown[]): WarehouseShipmentQueueReadRow[] {
  return (rows as Array<Record<string, unknown>>).flatMap((row) => {
    const id = stringValue(row.id);
    if (!id) return [];
    return [{
      queue_key: `REPLENISHMENT:${id}`,
      id,
      source: "REPLENISHMENT",
      request_no: stringValue(row.request_no),
      distribution_date: stringValue(row.submitted_at ?? row.created_at),
      row_version: numberValue(row.row_version),
      shipment_id: null,
      shipment_no: null,
      shipment_status: null,
      shipment_created_by: null,
    }];
  });
}

async function loadHrQueue(client: SupabaseClient): Promise<{ data: WarehouseShipmentQueueReadRow[]; error: SupabaseSessionError | null }> {
  const [result] = await retrySupabaseQueriesAfterSessionRefresh(
    client,
    async () => [await client.from("hr_requests")
      .select(embeddedHrRequestSelect)
      .eq("status", "SUBMITTED")
      .eq("draft_shipment.status", "DRAFT")] as const,
  );
  if (!result.error) return { data: mapHrRequests(result.data ?? [], new Map(), true), error: null };

  if (result.error.code !== "PGRST200" && result.error.code !== "PGRST201") {
    return { data: [], error: result.error };
  }

  const [requestResult] = await retrySupabaseQueriesAfterSessionRefresh(
    client,
    async () => [await client.from("hr_requests")
      .select(hrRequestSelect)
      .eq("status", "SUBMITTED")] as const,
  );
  if (requestResult.error) return { data: [], error: requestResult.error };

  const requests = (requestResult.data ?? []) as Array<Record<string, unknown>>;
  const requestIds = requests.flatMap((row) => typeof row.id === "string" ? [row.id] : []);
  if (requestIds.length === 0) return { data: [], error: null };

  const [shipmentResult] = await retrySupabaseQueriesAfterSessionRefresh(
    client,
    async () => [await client.from("warehouse_shipments")
      .select(shipmentSelect)
      .in("hr_request_id", requestIds)
      .eq("status", "DRAFT")] as const,
  );
  if (shipmentResult.error) return { data: [], error: shipmentResult.error };

  const shipmentByRequestId = new Map(
    ((shipmentResult.data ?? []) as Array<Record<string, unknown>>)
      .filter((row) => row.status === "DRAFT" && typeof row.hr_request_id === "string")
      .map((row) => [String(row.hr_request_id), row]),
  );
  return { data: mapHrRequests(requests, shipmentByRequestId), error: null };
}

async function loadReplenishmentQueue(client: SupabaseClient): Promise<{ data: WarehouseShipmentQueueReadRow[]; error: SupabaseSessionError | null }> {
  const [result] = await retrySupabaseQueriesAfterSessionRefresh(
    client,
    async () => [await client.from("replenishment_requests")
      .select(replenishmentSelect)
      .eq("status", "SUBMITTED")] as const,
  );
  return result.error
    ? { data: [], error: result.error }
    : { data: mapReplenishments(result.data ?? []), error: null };
}

async function loadLegacyQueue(client: SupabaseClient): Promise<WarehouseShipmentQueueReadResult> {
  const [hrResult, replenishmentResult] = await Promise.all([
    loadHrQueue(client),
    loadReplenishmentQueue(client),
  ]);
  const error = hrResult.error ?? replenishmentResult.error;
  return {
    data: error ? [] : [...hrResult.data, ...replenishmentResult.data],
    error,
    usedLegacyFallback: true,
  };
}

/**
 * Reads submitted HR and replenishment work through the consolidated queue
 * view; if it is not deployed yet, uses the same RLS-protected source tables.
 */
export async function loadWarehouseShipmentQueue(client: SupabaseClient): Promise<WarehouseShipmentQueueReadResult> {
  const viewName = "v_warehouse_shipment_queue";
  if (!shouldProbeReadModel(client, viewName)) return loadLegacyQueue(client);

  const [viewResult] = await retrySupabaseQueriesAfterSessionRefresh(
    client,
    async () => [await client.from(viewName).select(viewSelect)] as const,
  );
  const useLegacyFallback = shouldUseLegacyReadModel(client, viewName, viewResult.error);
  if (!viewResult.error) {
    return { data: mapViewRows(viewResult.data ?? []), error: null, usedLegacyFallback: false };
  }
  if (!useLegacyFallback) return { data: [], error: viewResult.error, usedLegacyFallback: false };
  return loadLegacyQueue(client);
}
