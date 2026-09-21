import type { SupabaseClient } from "@supabase/supabase-js";

export type SupabaseSessionError = {
  code?: string | null;
  message?: string | null;
};

export type SupabaseQueryResult = {
  error: SupabaseSessionError | null;
};

const refreshFlights = new WeakMap<SupabaseClient, Promise<boolean>>();

async function refreshSessionOnce(client: SupabaseClient): Promise<boolean> {
  const activeFlight = refreshFlights.get(client);
  if (activeFlight) return activeFlight;

  const flight = client.auth.refreshSession()
    .then((result) => !result.error && Boolean(result.data.session))
    .catch(() => false)
    .finally(() => {
      if (refreshFlights.get(client) === flight) refreshFlights.delete(client);
    });
  refreshFlights.set(client, flight);
  return flight;
}

export function isSupabaseSessionSyncError(
  error: SupabaseSessionError | null | undefined,
): boolean {
  const message = (error?.message ?? "").toLocaleLowerCase();
  return error?.code === "PGRST301"
    || message.includes("jwt issued at future")
    || message.includes("jwt expired")
    || message.includes("invalid jwt");
}

/**
 * Retry one read batch after refreshing a transiently stale browser session.
 * The refresh is deliberately limited to one attempt; permission and schema
 * errors must remain visible to the caller as a normal failed read.
 */
export async function retrySupabaseQueriesAfterSessionRefresh<
  T extends readonly SupabaseQueryResult[],
>(
  client: SupabaseClient,
  query: () => Promise<T>,
): Promise<T> {
  let result = await query();
  if (!result.some((entry) => isSupabaseSessionSyncError(entry.error))) return result;

  if (!await refreshSessionOnce(client)) return result;

  result = await query();
  return result;
}

export function safeSupabaseReadErrorMessage(
  error: SupabaseSessionError | null | undefined,
): string {
  if (isSupabaseSessionSyncError(error)) {
    return "登入狀態尚未同步，已重新整理登入狀態；請按「重新整理」再試。";
  }
  return "資料暫時無法載入，請按「重新整理」再試。";
}

export function safeSupabaseMutationErrorMessage(
  error: SupabaseSessionError | null | undefined,
  fallback = "操作尚未完成，請保留目前資料並使用相同按鈕重試。",
): string {
  if (isSupabaseSessionSyncError(error)) {
    return "登入狀態尚未同步，請重新整理登入狀態後再試；目前操作不會重複建立資料。";
  }
  return fallback;
}
