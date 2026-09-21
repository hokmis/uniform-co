import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadAccountBoundOverviewCore, loadOverviewCore, loadOverviewCoreReadAhead } from "./overview-dashboard-read";

function queryBuilder(result: unknown) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    order: vi.fn(() => builder),
    limit: vi.fn(async () => result),
    maybeSingle: vi.fn(async () => result),
  };
  return builder;
}

function clientFrom(builders: Record<string, ReturnType<typeof queryBuilder>>): SupabaseClient {
  return {
    from: vi.fn((table: string) => builders[table]),
    auth: { refreshSession: vi.fn() },
  } as unknown as SupabaseClient;
}

function queriedTables(client: SupabaseClient): string[] {
  const from = client.from as unknown as { mock: { calls: Array<[string]> } };
  return from.mock.calls.map(([table]) => table);
}

describe("overview dashboard read adapter", () => {
  it("returns an account-bound snapshot from the same security-invoker view read", async () => {
    const view = queryBuilder({
      data: {
        snapshot_key: "current",
        availability: [{ item_code: "SHIRT-M" }],
        hr_requests: [],
        shipments: [],
        receipts: [],
        account_id: "account-a",
      },
      error: null,
    });
    const client = clientFrom({ v_overview_core: view });

    await expect(loadAccountBoundOverviewCore(client)).resolves.toEqual({
      accountId: "account-a",
      result: {
        data: { availability: [{ item_code: "SHIRT-M" }], hrRequests: [], shipments: [], receipts: [] },
        errors: {},
        usedLegacyFallback: false,
      },
    });
    expect(view.select).toHaveBeenCalledWith("snapshot_key,availability,hr_requests,shipments,receipts,account_id");
  });

  it("does not treat an older core view without account_id as a missing view", async () => {
    const view = queryBuilder({
      data: null,
      error: { code: "PGRST204", message: "Could not find the account_id column of v_overview_core in the schema cache" },
    });
    view.maybeSingle
      .mockResolvedValueOnce({
        data: null,
        error: { code: "PGRST204", message: "Could not find the account_id column of v_overview_core in the schema cache" },
      })
      .mockResolvedValueOnce({
        data: { snapshot_key: "current", availability: [], hr_requests: [], shipments: [], receipts: [] },
        error: null,
      });
    const client = clientFrom({ v_overview_core: view });

    await expect(loadAccountBoundOverviewCore(client)).resolves.toBeNull();
    expect(view.select).toHaveBeenCalledOnce();

    const legacyCompatibleResult = await loadOverviewCore(client);

    expect(legacyCompatibleResult.usedLegacyFallback).toBe(false);
    expect(view.select).toHaveBeenCalledTimes(2);
    expect(view.select).toHaveBeenLastCalledWith("snapshot_key,availability,hr_requests,shipments,receipts");
  });

  it("caches a genuinely missing overview view and leaves the existing fallback available", async () => {
    const view = queryBuilder({ data: null, error: { code: "PGRST205", message: "Could not find v_overview_core" } });
    const availability = queryBuilder({ data: [], error: null });
    const hrRequests = queryBuilder({ data: [], error: null });
    const shipments = queryBuilder({ data: [], error: null });
    const receipts = queryBuilder({ data: [], error: null });
    const client = clientFrom({
      v_overview_core: view,
      v_item_availability: availability,
      v_hr_request_item_totals: hrRequests,
      v_pending_warehouse_shipments: shipments,
      v_purchase_order_receipt_progress: receipts,
    });

    await expect(loadAccountBoundOverviewCore(client)).resolves.toBeNull();
    const result = await loadOverviewCore(client);

    expect(result.usedLegacyFallback).toBe(true);
    expect(queriedTables(client).filter((table) => table === "v_overview_core")).toHaveLength(1);
  });

  it("starts the same Auth user's compatibility reads before workspace identity resolves", async () => {
    const view = queryBuilder({ data: null, error: { code: "PGRST205", message: "Could not find v_overview_core" } });
    const availability = queryBuilder({ data: [{ item_code: "PANTS-L" }], error: null });
    const hrRequests = queryBuilder({ data: [], error: null });
    const shipments = queryBuilder({ data: [], error: null });
    const receipts = queryBuilder({ data: [], error: null });
    const client = clientFrom({
      v_overview_core: view,
      v_item_availability: availability,
      v_hr_request_item_totals: hrRequests,
      v_pending_warehouse_shipments: shipments,
      v_purchase_order_receipt_progress: receipts,
    });
    let identityResolved = false;
    let resolveIdentity!: () => void;
    const identityPromise = new Promise<void>((resolve) => { resolveIdentity = resolve; });

    const readAhead = await loadOverviewCoreReadAhead(client, "auth-user-a");

    expect(identityResolved).toBe(false);
    expect(readAhead).toMatchObject({
      authUserId: "auth-user-a",
      binding: "auth-user",
      result: {
        data: { availability: [{ item_code: "PANTS-L" }] },
        usedLegacyFallback: true,
      },
    });
    expect(queriedTables(client)).toEqual([
      "v_overview_core",
      "v_item_availability",
      "v_hr_request_item_totals",
      "v_pending_warehouse_shipments",
      "v_purchase_order_receipt_progress",
    ]);

    resolveIdentity();
    await identityPromise;
  });

  it("preserves a permission failure without repeating the optimized view read", async () => {
    const view = queryBuilder({ data: null, error: { code: "42501", message: "permission denied" } });
    const client = clientFrom({ v_overview_core: view });

    await expect(loadOverviewCoreReadAhead(client, "auth-user-a")).resolves.toMatchObject({
      authUserId: "auth-user-a",
      binding: "auth-user",
      result: {
        errors: { availability: { code: "42501" } },
        usedLegacyFallback: false,
      },
    });
    expect(queriedTables(client)).toEqual(["v_overview_core"]);
  });

  it("maps the core snapshot through one read", async () => {
    const view = queryBuilder({
      data: {
        snapshot_key: "current",
        availability: [{ item_code: "SHIRT-M", available_to_request_quantity: 4 }],
        hr_requests: [{ request_id: "request-1", status: "SUBMITTED" }],
        shipments: [{ shipment_id: "shipment-1", needs_warehouse_attention: false }],
        receipts: [{ purchase_order_id: "po-1", remaining_to_accept: 3 }],
      },
      error: null,
    });
    const client = clientFrom({ v_overview_core: view });

    await expect(loadOverviewCore(client)).resolves.toEqual({
      data: {
        availability: [{ item_code: "SHIRT-M", available_to_request_quantity: 4 }],
        hrRequests: [{ request_id: "request-1", status: "SUBMITTED" }],
        shipments: [{ shipment_id: "shipment-1", needs_warehouse_attention: false }],
        receipts: [{ purchase_order_id: "po-1", remaining_to_accept: 3 }],
      },
      errors: {},
      usedLegacyFallback: false,
    });
    expect(client.from).toHaveBeenCalledTimes(1);
    expect(view.select).toHaveBeenCalledWith("snapshot_key,availability,hr_requests,shipments,receipts");
  });

  it("falls back to the existing four reads during a rolling migration", async () => {
    const view = queryBuilder({ data: null, error: { code: "PGRST205", message: "Could not find the table" } });
    const availability = queryBuilder({ data: [{ item_code: "PANTS-L" }], error: null });
    const hrRequests = queryBuilder({ data: [{ request_id: "request-2" }], error: null });
    const shipments = queryBuilder({ data: [{ shipment_id: "shipment-2" }], error: null });
    const receipts = queryBuilder({ data: [{ purchase_order_id: "po-2" }], error: null });
    const client = clientFrom({
      v_overview_core: view,
      v_item_availability: availability,
      v_hr_request_item_totals: hrRequests,
      v_pending_warehouse_shipments: shipments,
      v_purchase_order_receipt_progress: receipts,
    });

    const result = await loadOverviewCore(client);

    expect(result).toEqual({
      data: {
        availability: [{ item_code: "PANTS-L" }],
        hrRequests: [{ request_id: "request-2" }],
        shipments: [{ shipment_id: "shipment-2" }],
        receipts: [{ purchase_order_id: "po-2" }],
      },
      errors: { availability: null, hrRequests: null, shipments: null, receipts: null },
      usedLegacyFallback: true,
    });
    expect(client.from).toHaveBeenCalledWith("v_item_availability");
    expect(client.from).toHaveBeenCalledWith("v_purchase_order_receipt_progress");
  });

  it("does not repeat the missing-view round trip for every overview refresh", async () => {
    const view = queryBuilder({ data: null, error: { code: "PGRST205", message: "Could not find the table" } });
    const availability = queryBuilder({ data: [], error: null });
    const hrRequests = queryBuilder({ data: [], error: null });
    const shipments = queryBuilder({ data: [], error: null });
    const receipts = queryBuilder({ data: [], error: null });
    const client = clientFrom({
      v_overview_core: view,
      v_item_availability: availability,
      v_hr_request_item_totals: hrRequests,
      v_pending_warehouse_shipments: shipments,
      v_purchase_order_receipt_progress: receipts,
    });

    await loadOverviewCore(client);
    await loadOverviewCore(client);

    expect(queriedTables(client).filter((table) => table === "v_overview_core")).toHaveLength(1);
    expect(queriedTables(client).filter((table) => table === "v_item_availability")).toHaveLength(2);
  });

  it("does not hide a permission failure behind the fallback", async () => {
    const view = queryBuilder({ data: null, error: { code: "42501", message: "permission denied" } });
    const client = clientFrom({ v_overview_core: view });

    const result = await loadOverviewCore(client);

    expect(result.usedLegacyFallback).toBe(false);
    expect(result.errors.availability).toMatchObject({ code: "42501" });
    expect(client.from).toHaveBeenCalledTimes(1);
  });

  it("limits the legacy fallback to the requested core summaries", async () => {
    const view = queryBuilder({ data: null, error: { code: "PGRST205", message: "Could not find the table" } });
    const availability = queryBuilder({ data: [{ item_code: "PANTS-L" }], error: null });
    const receipts = queryBuilder({ data: [{ purchase_order_id: "po-3" }], error: null });
    const client = clientFrom({
      v_overview_core: view,
      v_item_availability: availability,
      v_purchase_order_receipt_progress: receipts,
    });

    const result = await loadOverviewCore(client, ["availability", "receipts"]);

    expect(result.data).toEqual({
      availability: [{ item_code: "PANTS-L" }],
      hrRequests: [],
      shipments: [],
      receipts: [{ purchase_order_id: "po-3" }],
    });
    expect(result.usedLegacyFallback).toBe(true);
    expect(client.from).not.toHaveBeenCalledWith("v_hr_request_item_totals");
    expect(client.from).not.toHaveBeenCalledWith("v_pending_warehouse_shipments");
  });

  it("projects only the requested view fields during a partial refresh", async () => {
    const view = queryBuilder({
      data: {
        snapshot_key: "current",
        availability: [{ item_code: "SHIRT-M" }],
      },
      error: null,
    });
    const client = clientFrom({ v_overview_core: view });

    const result = await loadOverviewCore(client, ["availability"]);

    expect(result.data).toEqual({
      availability: [{ item_code: "SHIRT-M" }],
      hrRequests: [],
      shipments: [],
      receipts: [],
    });
    expect(view.select).toHaveBeenCalledWith("snapshot_key,availability");
  });
});
