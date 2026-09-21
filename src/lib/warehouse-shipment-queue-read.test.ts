import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadWarehouseShipmentQueue } from "./warehouse-shipment-queue-read";

function queryBuilder(result: unknown) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    in: vi.fn(() => builder),
    then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(onFulfilled, onRejected),
  };
  return builder;
}

function clientFrom(resolve: (table: string) => ReturnType<typeof queryBuilder>): SupabaseClient {
  return {
    from: vi.fn(resolve),
    auth: { refreshSession: vi.fn() },
  } as unknown as SupabaseClient;
}

const hrRequest = {
  id: "hr-1",
  request_no: "REQ-001",
  distribution_date: "2026-09-20",
  row_version: 4,
};

describe("warehouse shipment queue read adapter", () => {
  it("reads the shaped queue view in one request", async () => {
    const view = queryBuilder({
      data: [{
        queue_key: "HR_REQUEST:hr-1",
        ...hrRequest,
        source: "HR_REQUEST",
        shipment_id: "shipment-1",
        shipment_no: "SHIP-001",
        shipment_status: "DRAFT",
        shipment_created_by: "account-1",
      }],
      error: null,
    });
    const client = clientFrom((table) => {
      if (table === "v_warehouse_shipment_queue") return view;
      throw new Error(`unexpected table ${table}`);
    });

    await expect(loadWarehouseShipmentQueue(client)).resolves.toEqual({
      data: [{
        queue_key: "HR_REQUEST:hr-1",
        ...hrRequest,
        source: "HR_REQUEST",
        shipment_id: "shipment-1",
        shipment_no: "SHIP-001",
        shipment_status: "DRAFT",
        shipment_created_by: "account-1",
      }],
      error: null,
      usedLegacyFallback: false,
    });
    expect(client.from).toHaveBeenCalledTimes(1);
  });

  it("rebuilds the queue from RLS-backed tables when the view is missing", async () => {
    const view = queryBuilder({ data: null, error: { code: "PGRST205", message: "Could not find the table v_warehouse_shipment_queue" } });
    const hrRequests = queryBuilder({
      data: [
        { ...hrRequest, draft_shipment: { id: "shipment-1", shipment_no: "SHIP-001", status: "DRAFT", created_by: "account-1" } },
        { ...hrRequest, id: "hr-2", request_no: "REQ-002", draft_shipment: null },
      ],
      error: null,
    });
    const replenishments = queryBuilder({
      data: [{ id: "replenishment-1", request_no: "REP-001", row_version: 2, submitted_at: null, created_at: "2026-09-19T12:00:00+00:00" }],
      error: null,
    });
    const client = clientFrom((table) => {
      if (table === "v_warehouse_shipment_queue") return view;
      if (table === "hr_requests") return hrRequests;
      if (table === "replenishment_requests") return replenishments;
      throw new Error(`unexpected table ${table}`);
    });

    const result = await loadWarehouseShipmentQueue(client);

    expect(result.error).toBeNull();
    expect(result.usedLegacyFallback).toBe(true);
    expect(result.data).toEqual([
      {
        queue_key: "HR_REQUEST:hr-1",
        ...hrRequest,
        source: "HR_REQUEST",
        shipment_id: "shipment-1",
        shipment_no: "SHIP-001",
        shipment_status: "DRAFT",
        shipment_created_by: "account-1",
      },
      {
        queue_key: "HR_REQUEST:hr-2",
        id: "hr-2",
        source: "HR_REQUEST",
        request_no: "REQ-002",
        distribution_date: "2026-09-20",
        row_version: 4,
        shipment_id: null,
        shipment_no: null,
        shipment_status: null,
        shipment_created_by: null,
      },
      {
        queue_key: "REPLENISHMENT:replenishment-1",
        id: "replenishment-1",
        source: "REPLENISHMENT",
        request_no: "REP-001",
        distribution_date: "2026-09-19T12:00:00+00:00",
        row_version: 2,
        shipment_id: null,
        shipment_no: null,
        shipment_status: null,
        shipment_created_by: null,
      },
    ]);
    expect(client.from).toHaveBeenCalledTimes(3);
    expect(hrRequests.select).toHaveBeenCalledWith(expect.stringContaining("draft_shipment:warehouse_shipments!warehouse_shipments_hr_request_id_fkey"));
    expect(hrRequests.eq).toHaveBeenCalledWith("status", "SUBMITTED");
    expect(hrRequests.eq).toHaveBeenCalledWith("draft_shipment.status", "DRAFT");
  });

  it("falls back to a separate draft-shipment lookup only when relationship metadata is unavailable", async () => {
    const view = queryBuilder({ data: null, error: { code: "PGRST205", message: "Could not find the view" } });
    const embedded = queryBuilder({ data: null, error: { code: "PGRST200", message: "Could not find a relationship" } });
    const hrRequests = queryBuilder({ data: [hrRequest], error: null });
    const shipments = queryBuilder({ data: [{ hr_request_id: "hr-1", id: "shipment-1", shipment_no: "SHIP-001", status: "DRAFT", created_by: "account-1" }], error: null });
    const replenishments = queryBuilder({ data: [], error: null });
    let hrReadCount = 0;
    const client = clientFrom((table) => {
      if (table === "v_warehouse_shipment_queue") return view;
      if (table === "hr_requests") return hrReadCount++ === 0 ? embedded : hrRequests;
      if (table === "warehouse_shipments") return shipments;
      if (table === "replenishment_requests") return replenishments;
      throw new Error(`unexpected table ${table}`);
    });

    const result = await loadWarehouseShipmentQueue(client);

    expect(result.error).toBeNull();
    expect(result.data[0]).toMatchObject({ shipment_id: "shipment-1", shipment_status: "DRAFT" });
    expect(client.from).toHaveBeenCalledWith("warehouse_shipments");
    expect(shipments.in).toHaveBeenCalledWith("hr_request_id", ["hr-1"]);
  });

  it("does not hide permission errors behind the legacy fallback", async () => {
    const view = queryBuilder({ data: null, error: { code: "42501", message: "permission denied" } });
    const client = clientFrom((table) => {
      if (table === "v_warehouse_shipment_queue") return view;
      throw new Error(`unexpected table ${table}`);
    });

    const result = await loadWarehouseShipmentQueue(client);

    expect(result).toMatchObject({ data: [], error: { code: "42501" }, usedLegacyFallback: false });
    expect(client.from).toHaveBeenCalledTimes(1);
  });

  it("fails closed instead of displaying a partial queue when either base read fails", async () => {
    const view = queryBuilder({ data: null, error: { code: "PGRST205", message: "Could not find the view" } });
    const hrRequests = queryBuilder({ data: [hrRequest], error: null });
    const replenishments = queryBuilder({ data: null, error: { code: "42501", message: "permission denied" } });
    const client = clientFrom((table) => {
      if (table === "v_warehouse_shipment_queue") return view;
      if (table === "hr_requests") return hrRequests;
      if (table === "replenishment_requests") return replenishments;
      throw new Error(`unexpected table ${table}`);
    });

    const result = await loadWarehouseShipmentQueue(client);

    expect(result).toMatchObject({ data: [], error: { code: "42501" }, usedLegacyFallback: true });
  });
});
