import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadTransferCorrectionSources, loadStocktakeCorrectionSources } from "./correction-source-read";

function clientFrom(results: Record<string, { data: unknown[] | null; error: { code: string; message: string } | null }>): SupabaseClient {
  return {
    from: vi.fn((name: string) => {
      const result = results[name];
      const query = {
        select: () => query, eq: () => query, in: () => query,
        order: () => query, then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
      };
      return query;
    }),
    auth: { refreshSession: vi.fn() },
  } as unknown as SupabaseClient;
}

const missing = { data: null, error: { code: "PGRST205", message: "Could not find the table" } };

describe("correction source reads", () => {
  it("uses actual item relationships in both migration views, not nonexistent line snapshots", () => {
    for (const name of ["0105_warehouse_transfer_correction_source_view.sql", "0106_stocktake_correction_source_view.sql"]) {
      const sql = readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), "utf8");
      expect(sql).toContain("join public.uniform_items");
      expect(sql).not.toContain("line.item_code_snapshot");
      expect(sql).not.toContain("line.item_name_snapshot");
    }
  });
  it("loads a posted transfer when its rollout view is missing", async () => {
    const client = clientFrom({
      v_warehouse_transfer_correction_sources: missing,
      warehouse_shipments: { data: [{ id: "shipment", shipment_no: "S-1", status: "POSTED" }], error: null },
      warehouse_shipment_lines: { data: [{ id: "line", shipment_id: "shipment", item_id: "item", actual_transfer_quantity: 2, requested_transfer_quantity_snapshot: 3 }], error: null },
      replenishment_requests: { data: [], error: null },
      replenishment_request_lines: { data: [], error: null },
      uniform_items: { data: [{ id: "item", item_code: "ITEM", item_name: "制服" }], error: null },
    });
    const result = await loadTransferCorrectionSources(client);
    expect(result.error).toBeNull();
    expect(result.data).toEqual([{ kind: "SHIPMENT", lineId: "line", parentId: "shipment", parentNo: "S-1", itemCode: "ITEM", itemName: "制服", actual: 2, requested: 3 }]);
  });

  it("loads a posted stocktake when its rollout view is missing", async () => {
    const client = clientFrom({
      v_stocktake_correction_sources: missing,
      stocktakes: { data: [{ id: "count", stocktake_no: "C-1", status: "POSTED", warehouse_id: "warehouse" }], error: null },
      stocktake_lines: { data: [{ id: "line", stocktake_id: "count", item_id: "item", counted_quantity: 5, book_quantity_snapshot: 4 }], error: null },
      warehouses: { data: [{ id: "warehouse", purpose: "HR", is_active: true }], error: null },
      uniform_items: { data: [{ id: "item", item_code: "ITEM", item_name: "制服" }], error: null },
    });
    const result = await loadStocktakeCorrectionSources(client);
    expect(result.error).toBeNull();
    expect(result.data).toEqual([{ lineId: "line", stocktakeId: "count", stocktakeNo: "C-1", itemCode: "ITEM", itemName: "制服", warehouseId: "warehouse", warehousePurpose: "HR", counted: 5, book: 4 }]);
  });

  it("does not bypass a permission-denied view", async () => {
    const client = clientFrom({ v_stocktake_correction_sources: { data: null, error: { code: "42501", message: "permission denied" } } });
    expect((await loadStocktakeCorrectionSources(client)).error?.code).toBe("42501");
    expect(client.from).toHaveBeenCalledTimes(1);
  });
});
