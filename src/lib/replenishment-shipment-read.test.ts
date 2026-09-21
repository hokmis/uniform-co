import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadReplenishmentShipmentLines } from "./replenishment-shipment-read";

function queryBuilder(result: unknown) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    order: vi.fn(async () => result),
    in: vi.fn(async () => result),
  };
  return builder;
}

function clientFrom(builders: Record<string, ReturnType<typeof queryBuilder>>): SupabaseClient {
  return {
    from: vi.fn((table: string) => builders[table]),
    auth: { refreshSession: vi.fn() },
  } as unknown as SupabaseClient;
}

describe("replenishment shipment read adapter", () => {
  it("maps the server-shaped view in one read", async () => {
    const view = queryBuilder({
      data: [{
        id: "line-1",
        request_id: "request-1",
        item_id: "item-1",
        requested_quantity: 8,
        item_code_snapshot: "SHIRT-M",
        item_name_snapshot: "制服上衣",
        unit_snapshot: "件",
        maximum_transfer_quantity_snapshot: null,
        actual_transfer_quantity: null,
        short_ship_reason_code: null,
        general_on_hand_quantity: 5,
        effective_maximum_transfer_quantity: 5,
      }],
      error: null,
    });
    const client = clientFrom({ v_replenishment_shipment_lines: view });

    await expect(loadReplenishmentShipmentLines(client, "request-1")).resolves.toEqual({
      data: [{
        id: "line-1",
        request_id: "request-1",
        item_id: "item-1",
        requested_quantity: 8,
        item_code_snapshot: "SHIRT-M",
        item_name_snapshot: "制服上衣",
        unit_snapshot: "件",
        maximum_transfer_quantity_snapshot: null,
        actual_transfer_quantity: null,
        short_ship_reason_code: null,
        general_on_hand_quantity: 5,
        effective_maximum_transfer_quantity: 5,
      }],
      error: null,
      usedLegacyFallback: false,
    });
    expect(client.from).toHaveBeenCalledTimes(1);
    expect(view.select).toHaveBeenCalledWith("id,request_id,item_id,requested_quantity,item_code_snapshot,item_name_snapshot,unit_snapshot,maximum_transfer_quantity_snapshot,actual_transfer_quantity,short_ship_reason_code,general_on_hand_quantity,effective_maximum_transfer_quantity");
  });

  it("falls back to the existing two reads during a rolling migration", async () => {
    const view = queryBuilder({ data: null, error: { code: "PGRST205", message: "Could not find the table" } });
    const lines = queryBuilder({
      data: [{
        id: "line-2",
        request_id: "request-2",
        item_id: "item-2",
        requested_quantity: 4,
        item_code_snapshot: "PANTS-L",
        item_name_snapshot: "制服長褲",
        unit_snapshot: "件",
        maximum_transfer_quantity_snapshot: null,
        actual_transfer_quantity: null,
        short_ship_reason_code: null,
      }],
      error: null,
    });
    const availability = queryBuilder({ data: [{ item_id: "item-2", general_on_hand_quantity: 3 }], error: null });
    const client = clientFrom({ v_replenishment_shipment_lines: view, replenishment_request_lines: lines, v_item_availability: availability });

    const result = await loadReplenishmentShipmentLines(client, "request-2");

    expect(result).toEqual({
      data: [{
        id: "line-2",
        request_id: "request-2",
        item_id: "item-2",
        requested_quantity: 4,
        item_code_snapshot: "PANTS-L",
        item_name_snapshot: "制服長褲",
        unit_snapshot: "件",
        maximum_transfer_quantity_snapshot: null,
        actual_transfer_quantity: null,
        short_ship_reason_code: null,
        general_on_hand_quantity: 3,
        effective_maximum_transfer_quantity: 3,
      }],
      error: null,
      usedLegacyFallback: true,
    });
    expect(client.from).toHaveBeenCalledWith("replenishment_request_lines");
    expect(client.from).toHaveBeenCalledWith("v_item_availability");
  });

  it("does not hide permission failures behind the fallback", async () => {
    const view = queryBuilder({ data: null, error: { code: "42501", message: "permission denied" } });
    const client = clientFrom({ v_replenishment_shipment_lines: view });

    const result = await loadReplenishmentShipmentLines(client, "request-3");

    expect(result.error).toMatchObject({ code: "42501" });
    expect(result.usedLegacyFallback).toBe(false);
    expect(client.from).toHaveBeenCalledTimes(1);
  });
});
