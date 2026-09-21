import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadWarehouseShipmentLines } from "./warehouse-shipment-read";

function queryBuilder(result: unknown) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    order: vi.fn(async () => result),
  };
  return builder;
}

function clientFrom(builders: Record<string, ReturnType<typeof queryBuilder>>): SupabaseClient {
  return {
    from: vi.fn((table: string) => builders[table]),
    auth: { refreshSession: vi.fn() },
  } as unknown as SupabaseClient;
}

describe("warehouse shipment read adapter", () => {
  it("maps the complete shipment line from one view read", async () => {
    const view = queryBuilder({
      data: [{
        id: "line-1",
        item_id: "item-1",
        hr_request_item_id: "request-item-1",
        item_code_snapshot: "SHIRT-M",
        item_name_snapshot: "制服上衣",
        unit_snapshot: "件",
        requested_transfer_quantity_snapshot: 5,
        maximum_transfer_quantity_snapshot: 5,
        actual_transfer_quantity: 3,
        short_ship_reason_code: "OUT_OF_STOCK",
      }],
      error: null,
    });
    const client = clientFrom({ v_warehouse_shipment_lines: view });

    await expect(loadWarehouseShipmentLines(client, "shipment-1", "request-1")).resolves.toMatchObject({
      data: [{ id: "line-1", item_code_snapshot: "SHIRT-M", actual_transfer_quantity: 3 }],
      error: null,
      usedLegacyFallback: false,
    });
    expect(client.from).toHaveBeenCalledTimes(1);
  });

  it("uses one embedded foreign-key read when the consolidated view is missing", async () => {
    const view = queryBuilder({ data: null, error: { code: "PGRST205", message: "Could not find the table" } });
    const lines = queryBuilder({
      data: [{
        id: "line-2",
        item_id: "item-2",
        hr_request_item_id: "request-item-2",
        requested_transfer_quantity_snapshot: 4,
        maximum_transfer_quantity_snapshot: 4,
        actual_transfer_quantity: 4,
        short_ship_reason_code: null,
        hr_request_item: { item_code_snapshot: "PANTS-L", item_name_snapshot: "制服長褲", unit_snapshot: "件" },
      }],
      error: null,
    });
    const items = queryBuilder({ data: [{ id: "request-item-2", item_code_snapshot: "PANTS-L", item_name_snapshot: "制服長褲", unit_snapshot: "件" }], error: null });
    const client = clientFrom({ v_warehouse_shipment_lines: view, warehouse_shipment_lines: lines, hr_request_items: items });

    const result = await loadWarehouseShipmentLines(client, "shipment-2", "request-2");

    expect(result.data[0]).toMatchObject({ id: "line-2", item_code_snapshot: "PANTS-L", item_name_snapshot: "制服長褲" });
    expect(result.usedLegacyFallback).toBe(true);
    expect(client.from).toHaveBeenCalledWith("warehouse_shipment_lines");
    expect(client.from).not.toHaveBeenCalledWith("hr_request_items");
    expect(client.from).toHaveBeenCalledTimes(2);
    expect(lines.select).toHaveBeenCalledWith(expect.stringContaining("hr_request_item:hr_request_items("));
  });

  it("retains the two-query fallback when PostgREST cannot resolve the embedded relation", async () => {
    const view = queryBuilder({ data: null, error: { code: "PGRST205", message: "Could not find the table" } });
    const embedded = queryBuilder({ data: null, error: { code: "PGRST200", message: "Could not find a relationship" } });
    const lines = queryBuilder({
      data: [{ id: "line-3", item_id: "item-3", hr_request_item_id: "request-item-3", requested_transfer_quantity_snapshot: 4, maximum_transfer_quantity_snapshot: 4, actual_transfer_quantity: 4, short_ship_reason_code: null }],
      error: null,
    });
    const items = queryBuilder({ data: [{ id: "request-item-3", item_code_snapshot: "SHIRT-L", item_name_snapshot: "制服上衣", unit_snapshot: "件" }], error: null });
    let shipmentLineReadCount = 0;
    const client = {
      from: vi.fn((table: string) => {
        if (table === "v_warehouse_shipment_lines") return view;
        if (table === "warehouse_shipment_lines") return shipmentLineReadCount++ === 0 ? embedded : lines;
        if (table === "hr_request_items") return items;
        throw new Error("unexpected table");
      }),
      auth: { refreshSession: vi.fn() },
    } as unknown as SupabaseClient;

    const result = await loadWarehouseShipmentLines(client, "shipment-3", "request-3");

    expect(result.data[0]).toMatchObject({ id: "line-3", item_code_snapshot: "SHIRT-L", item_name_snapshot: "制服上衣" });
    expect(result.usedLegacyFallback).toBe(true);
    expect(client.from).toHaveBeenCalledWith("hr_request_items");
  });

  it("does not hide permission errors behind either compatibility fallback", async () => {
    const view = queryBuilder({ data: null, error: { code: "PGRST205", message: "Could not find the table" } });
    const lines = queryBuilder({ data: null, error: { code: "42501", message: "permission denied" } });
    const client = clientFrom({ v_warehouse_shipment_lines: view, warehouse_shipment_lines: lines });

    const result = await loadWarehouseShipmentLines(client, "shipment-4", "request-4");

    expect(result.error).toMatchObject({ code: "42501" });
    expect(client.from).toHaveBeenCalledTimes(2);
    expect(client.from).not.toHaveBeenCalledWith("hr_request_items");
  });

  it("does not hide a permission error on the consolidated view", async () => {
    const view = queryBuilder({ data: null, error: { code: "42501", message: "permission denied" } });
    const client = clientFrom({ v_warehouse_shipment_lines: view });

    const result = await loadWarehouseShipmentLines(client, "shipment-3", "request-3");

    expect(result.error).toMatchObject({ code: "42501" });
    expect(result.usedLegacyFallback).toBe(false);
    expect(client.from).toHaveBeenCalledTimes(1);
  });
});
