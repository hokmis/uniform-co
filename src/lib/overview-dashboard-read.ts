import type { SupabaseClient } from "@supabase/supabase-js";
import { retrySupabaseQueriesAfterSessionRefresh, type SupabaseSessionError } from "./supabase-session";
import { shouldProbeReadModel, shouldUseLegacyReadModel } from "./read-model-rollout";

export type OverviewDashboardRow = Record<string, unknown>;
export type OverviewCoreKey = "availability" | "hrRequests" | "shipments" | "receipts";

export type OverviewCoreData = Record<OverviewCoreKey, OverviewDashboardRow[]>;

export type OverviewCoreReadResult = {
  data: OverviewCoreData;
  errors: Partial<Record<OverviewCoreKey, SupabaseSessionError | null>>;
  usedLegacyFallback: boolean;
};

export type AccountBoundOverviewCoreRead = {
  accountId: string;
  result: OverviewCoreReadResult;
};

export type OverviewCoreReadAhead =
  | ({ authUserId: string; binding: "account" } & AccountBoundOverviewCoreRead)
  | { authUserId: string; binding: "auth-user"; result: OverviewCoreReadResult };

type AccountBoundOverviewCoreAttempt =
  | { kind: "bound"; read: AccountBoundOverviewCoreRead }
  | { kind: "missing-view" | "missing-account-id" }
  | { kind: "unbound-result"; result: OverviewCoreReadResult };

const coreKeys: readonly OverviewCoreKey[] = ["availability", "hrRequests", "shipments", "receipts"];
const coreViewFields: Record<OverviewCoreKey, string> = {
  availability: "availability",
  hrRequests: "hr_requests",
  shipments: "shipments",
  receipts: "receipts",
};

function coreViewSelect(requestedKeys: readonly OverviewCoreKey[], includeAccountId = false): string {
  const requested = new Set(requestedKeys);
  return [
    "snapshot_key",
    ...coreKeys.filter((key) => requested.has(key)).map((key) => coreViewFields[key]),
    ...(includeAccountId ? ["account_id"] : []),
  ].join(",");
}

function emptyData(): OverviewCoreData {
  return { availability: [], hrRequests: [], shipments: [], receipts: [] };
}

function rows(value: unknown): OverviewDashboardRow[] {
  return Array.isArray(value) ? value as OverviewDashboardRow[] : [];
}

function mapLegacyResult(
  results: readonly [{ data: unknown[] | null; error: SupabaseSessionError | null }, { data: unknown[] | null; error: SupabaseSessionError | null }, { data: unknown[] | null; error: SupabaseSessionError | null }, { data: unknown[] | null; error: SupabaseSessionError | null }],
): OverviewCoreReadResult {
  const [availability, hrRequests, shipments, receipts] = results;
  return {
    data: {
      availability: (availability.data ?? []) as OverviewDashboardRow[],
      hrRequests: (hrRequests.data ?? []) as OverviewDashboardRow[],
      shipments: (shipments.data ?? []) as OverviewDashboardRow[],
      receipts: (receipts.data ?? []) as OverviewDashboardRow[],
    },
    errors: {
      availability: availability.error,
      hrRequests: hrRequests.error,
      shipments: shipments.error,
      receipts: receipts.error,
    },
    usedLegacyFallback: true,
  };
}

async function loadLegacyCore(
  client: SupabaseClient,
  requestedKeys: readonly OverviewCoreKey[] = coreKeys,
): Promise<OverviewCoreReadResult> {
  const requested = new Set(requestedKeys);
  const emptyResult = { data: null, error: null } satisfies { data: unknown[] | null; error: SupabaseSessionError | null };
  const results = await retrySupabaseQueriesAfterSessionRefresh(
    client,
    () => Promise.all([
      requested.has("availability") ? client.from("v_item_availability")
        .select("item_code,item_name,available_to_request_quantity,combined_on_hand_quantity,active_reserved_quantity")
        .order("item_code")
        .limit(300) : Promise.resolve(emptyResult),
      requested.has("hrRequests") ? client.from("v_hr_request_item_totals")
        .select("request_id,request_no,status,distribution_date,created_at,requested_transfer_quantity")
        .order("created_at", { ascending: false })
        .limit(300) : Promise.resolve(emptyResult),
      requested.has("shipments") ? client.from("v_pending_warehouse_shipments")
        .select("shipment_id,shipment_no,request_no,distribution_date,needs_warehouse_attention")
        .order("distribution_date")
        .limit(300) : Promise.resolve(emptyResult),
      requested.has("receipts") ? client.from("v_purchase_order_receipt_progress")
        .select("purchase_order_id,po_no,ordered_quantity,accepted_to_date,remaining_to_accept")
        .order("remaining_to_accept", { ascending: false })
        .limit(300) : Promise.resolve(emptyResult),
    ]) as Promise<[
      { data: unknown[] | null; error: SupabaseSessionError | null },
      { data: unknown[] | null; error: SupabaseSessionError | null },
      { data: unknown[] | null; error: SupabaseSessionError | null },
      { data: unknown[] | null; error: SupabaseSessionError | null },
    ]>,
  );
  return mapLegacyResult(results);
}

/**
 * Reads the actionable overview summaries through one server-shaped view.
 * The legacy four-query path remains only while 0118 is rolling out; a real
 * permission or schema error from the deployed view is never hidden by it.
 */
export async function loadOverviewCore(
  client: SupabaseClient,
  requestedKeys: readonly OverviewCoreKey[] = coreKeys,
): Promise<OverviewCoreReadResult> {
  const viewName = "v_overview_core";
  if (!shouldProbeReadModel(client, viewName)) return loadLegacyCore(client, requestedKeys);

  const [viewResult] = await retrySupabaseQueriesAfterSessionRefresh(
    client,
    async () => [await client.from("v_overview_core")
      .select(coreViewSelect(requestedKeys))
      .eq("snapshot_key", "current")
      .maybeSingle()] as const,
  );
  const useLegacyFallback = shouldUseLegacyReadModel(client, viewName, viewResult.error);

  if (!viewResult.error && viewResult.data) {
    const source = viewResult.data as unknown as Record<string, unknown>;
    return {
      data: {
        availability: rows(source.availability),
        hrRequests: rows(source.hr_requests),
        shipments: rows(source.shipments),
        receipts: rows(source.receipts),
      },
      errors: {},
      usedLegacyFallback: false,
    };
  }
  if (viewResult.error && !useLegacyFallback) {
    const data = emptyData();
    return {
      data,
      errors: Object.fromEntries(coreKeys.map((key) => [key, viewResult.error])) as OverviewCoreReadResult["errors"],
      usedLegacyFallback: false,
    };
  }
  return loadLegacyCore(client, requestedKeys);
}

function isMissingOverviewAccountId(error: SupabaseSessionError | null): boolean {
  const message = (error?.message ?? "").toLocaleLowerCase();
  return (error?.code === "PGRST204" || error?.code === "42703")
    && message.includes("v_overview_core")
    && message.includes("account_id");
}

/**
 * Starts the optimized overview read before client identity resolves, but only
 * returns data with the account ID captured in the same SQL statement. Older
 * or incomplete schemas return null so the caller can use its identity-gated
 * compatibility path without displaying an unbound snapshot.
 */
async function attemptAccountBoundOverviewCore(
  client: SupabaseClient,
): Promise<AccountBoundOverviewCoreAttempt> {
  const viewName = "v_overview_core";
  if (!shouldProbeReadModel(client, viewName)) return { kind: "missing-view" };

  const [viewResult] = await retrySupabaseQueriesAfterSessionRefresh(
    client,
    async () => [await client.from(viewName)
      .select(coreViewSelect(coreKeys, true))
      .eq("snapshot_key", "current")
      .maybeSingle()] as const,
  );

  if (isMissingOverviewAccountId(viewResult.error)) return { kind: "missing-account-id" };
  if (shouldUseLegacyReadModel(client, viewName, viewResult.error)) return { kind: "missing-view" };
  if (viewResult.error) {
    return {
      kind: "unbound-result",
      result: {
        data: emptyData(),
        errors: Object.fromEntries(coreKeys.map((key) => [key, viewResult.error])) as OverviewCoreReadResult["errors"],
        usedLegacyFallback: false,
      },
    };
  }
  if (!viewResult.data) {
    return { kind: "unbound-result", result: { data: emptyData(), errors: {}, usedLegacyFallback: false } };
  }

  const source = viewResult.data as unknown as Record<string, unknown>;
  const result: OverviewCoreReadResult = {
    data: {
      availability: rows(source.availability),
      hrRequests: rows(source.hr_requests),
      shipments: rows(source.shipments),
      receipts: rows(source.receipts),
    },
    errors: {},
    usedLegacyFallback: false,
  };
  if (typeof source.account_id !== "string" || !source.account_id) {
    return { kind: "unbound-result", result };
  }

  return { kind: "bound", read: { accountId: source.account_id, result } };
}

export async function loadAccountBoundOverviewCore(
  client: SupabaseClient,
): Promise<AccountBoundOverviewCoreRead | null> {
  const attempt = await attemptAccountBoundOverviewCore(client);
  return attempt.kind === "bound" ? attempt.read : null;
}

/**
 * Starts the overview's compatibility reads while workspace account identity
 * resolves. The fallback views still run under the caller's Supabase Auth
 * session/RLS; callers must wait for the usual identity gate and match this
 * Auth user before displaying the result.
 */
export async function loadOverviewCoreReadAhead(
  client: SupabaseClient,
  authUserId: string,
): Promise<OverviewCoreReadAhead> {
  const attempt = await attemptAccountBoundOverviewCore(client);
  if (attempt.kind === "bound") {
    return { authUserId, binding: "account", ...attempt.read };
  }

  if (attempt.kind === "unbound-result") {
    return { authUserId, binding: "auth-user", result: attempt.result };
  }

  const result = attempt.kind === "missing-view"
    ? await loadLegacyCore(client)
    : await loadOverviewCore(client);

  return {
    authUserId,
    binding: "auth-user",
    result,
  };
}
