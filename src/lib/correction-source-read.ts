import type { SupabaseClient } from "@supabase/supabase-js";
import { retrySupabaseQueriesAfterSessionRefresh, type SupabaseSessionError } from "./supabase-session";
import { shouldProbeReadModel, shouldUseLegacyReadModel } from "./read-model-rollout";

export type TransferCorrectionSource = {
  kind: "SHIPMENT" | "REPLENISHMENT";
  lineId: string;
  parentId: string;
  parentNo: string;
  itemCode: string;
  itemName: string;
  actual: number;
  requested: number;
};
export type StocktakeCorrectionSource = {
  lineId: string;
  stocktakeId: string;
  stocktakeNo: string;
  itemCode: string;
  itemName: string;
  warehouseId: string;
  warehousePurpose: string;
  counted: number;
  book: number;
};
type ReadResult<T> = { data: T[]; error: SupabaseSessionError | null };

function rows(data: unknown): Array<Record<string, unknown>> {
  return Array.isArray(data) ? data as Array<Record<string, unknown>> : [];
}
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function quantity(value: unknown): number {
  return Number(value ?? 0);
}
function firstError(...errors: (SupabaseSessionError | null)[]): SupabaseSessionError | null {
  return errors.find(Boolean) ?? null;
}

async function legacyTransferSources(client: SupabaseClient): Promise<ReadResult<TransferCorrectionSource>> {
  const [shipments, shipmentLines, replenishments, replenishmentLines, items] = await retrySupabaseQueriesAfterSessionRefresh(
    client,
    async () => await Promise.all([
      client.from("warehouse_shipments").select("id,shipment_no,status").eq("status", "POSTED"),
      client.from("warehouse_shipment_lines").select("id,shipment_id,item_id,actual_transfer_quantity,requested_transfer_quantity_snapshot"),
      client.from("replenishment_requests").select("id,request_no,status").eq("status", "SHIPPED"),
      client.from("replenishment_request_lines").select("id,request_id,item_id,actual_transfer_quantity,requested_quantity"),
      client.from("uniform_items").select("id,item_code,item_name"),
    ]),
  );
  const error = firstError(shipments.error, shipmentLines.error, replenishments.error, replenishmentLines.error, items.error);
  if (error) return { data: [], error };
  const shipmentById = new Map(rows(shipments.data).map((row) => [text(row.id), row]));
  const replenishmentById = new Map(rows(replenishments.data).map((row) => [text(row.id), row]));
  const itemById = new Map(rows(items.data).map((row) => [text(row.id), row]));
  const data: TransferCorrectionSource[] = [];
  for (const row of rows(shipmentLines.data)) {
    const parent = shipmentById.get(text(row.shipment_id));
    const item = itemById.get(text(row.item_id));
    if (!parent || !item || row.actual_transfer_quantity == null) continue;
    data.push({ kind: "SHIPMENT", lineId: text(row.id), parentId: text(parent.id), parentNo: text(parent.shipment_no),
      itemCode: text(item.item_code), itemName: text(item.item_name),
      actual: quantity(row.actual_transfer_quantity), requested: quantity(row.requested_transfer_quantity_snapshot) });
  }
  for (const row of rows(replenishmentLines.data)) {
    const parent = replenishmentById.get(text(row.request_id));
    const item = itemById.get(text(row.item_id));
    if (!parent || !item || row.actual_transfer_quantity == null) continue;
    data.push({ kind: "REPLENISHMENT", lineId: text(row.id), parentId: text(parent.id), parentNo: text(parent.request_no),
      itemCode: text(item.item_code), itemName: text(item.item_name),
      actual: quantity(row.actual_transfer_quantity), requested: quantity(row.requested_quantity) });
  }
  data.sort((a, b) => b.parentNo.localeCompare(a.parentNo) || a.lineId.localeCompare(b.lineId));
  return { data, error: null };
}

export async function loadTransferCorrectionSources(client: SupabaseClient): Promise<ReadResult<TransferCorrectionSource>> {
  const name = "v_warehouse_transfer_correction_sources";
  if (!shouldProbeReadModel(client, name)) return legacyTransferSources(client);
  const [result] = await retrySupabaseQueriesAfterSessionRefresh(client,
    async () => [await client.from(name).select("source_kind,line_id,parent_id,parent_no,item_code,item_name,actual_quantity,requested_quantity").order("parent_no", { ascending: false }).order("line_id")] as const);
  if (result.error) {
    if (shouldUseLegacyReadModel(client, name, result.error)) return legacyTransferSources(client);
    return { data: [], error: result.error };
  }
  return { data: rows(result.data).filter((row) => row.actual_quantity != null).map((row) => ({
    kind: text(row.source_kind) as TransferCorrectionSource["kind"], lineId: text(row.line_id),
    parentId: text(row.parent_id), parentNo: text(row.parent_no),
    itemCode: text(row.item_code), itemName: text(row.item_name),
    actual: quantity(row.actual_quantity), requested: quantity(row.requested_quantity),
  })), error: null };
}

async function legacyStocktakeSources(client: SupabaseClient): Promise<ReadResult<StocktakeCorrectionSource>> {
  const [stocktakes, lines, warehouses, items] = await retrySupabaseQueriesAfterSessionRefresh(
    client,
    async () => await Promise.all([
      client.from("stocktakes").select("id,stocktake_no,status,warehouse_id").eq("status", "POSTED"),
      client.from("stocktake_lines").select("id,stocktake_id,item_id,counted_quantity,book_quantity_snapshot"),
      client.from("warehouses").select("id,purpose,is_active").eq("is_active", true),
      client.from("uniform_items").select("id,item_code,item_name"),
    ]),
  );
  const error = firstError(stocktakes.error, lines.error, warehouses.error, items.error);
  if (error) return { data: [], error };
  const stocktakeById = new Map(rows(stocktakes.data).map((row) => [text(row.id), row]));
  const warehouseById = new Map(rows(warehouses.data).map((row) => [text(row.id), row]));
  const itemById = new Map(rows(items.data).map((row) => [text(row.id), row]));
  const data: StocktakeCorrectionSource[] = [];
  for (const row of rows(lines.data)) {
    const stocktake = stocktakeById.get(text(row.stocktake_id));
    const warehouse = stocktake && warehouseById.get(text(stocktake.warehouse_id));
    const item = itemById.get(text(row.item_id));
    if (!stocktake || !warehouse || !item) continue;
    data.push({ lineId: text(row.id), stocktakeId: text(stocktake.id), stocktakeNo: text(stocktake.stocktake_no),
      warehouseId: text(warehouse.id), warehousePurpose: text(warehouse.purpose),
      itemCode: text(item.item_code), itemName: text(item.item_name),
      counted: quantity(row.counted_quantity), book: quantity(row.book_quantity_snapshot) });
  }
  data.sort((a, b) => b.stocktakeNo.localeCompare(a.stocktakeNo) || a.lineId.localeCompare(b.lineId));
  return { data, error: null };
}

export async function loadStocktakeCorrectionSources(client: SupabaseClient): Promise<ReadResult<StocktakeCorrectionSource>> {
  const name = "v_stocktake_correction_sources";
  if (!shouldProbeReadModel(client, name)) return legacyStocktakeSources(client);
  const [result] = await retrySupabaseQueriesAfterSessionRefresh(client,
    async () => [await client.from(name).select("line_id,stocktake_id,stocktake_no,warehouse_id,warehouse_purpose,item_code,item_name,counted_quantity,book_quantity").order("stocktake_no", { ascending: false }).order("line_id")] as const);
  if (result.error) {
    if (shouldUseLegacyReadModel(client, name, result.error)) return legacyStocktakeSources(client);
    return { data: [], error: result.error };
  }
  return { data: rows(result.data).map((row) => ({
    lineId: text(row.line_id), stocktakeId: text(row.stocktake_id), stocktakeNo: text(row.stocktake_no),
    warehouseId: text(row.warehouse_id), warehousePurpose: text(row.warehouse_purpose),
    itemCode: text(row.item_code), itemName: text(row.item_name),
    counted: quantity(row.counted_quantity), book: quantity(row.book_quantity),
  })), error: null };
}
