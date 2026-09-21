import { describe, expect, it, vi } from "vitest";
import {
  isSupabaseSessionSyncError,
  retrySupabaseQueriesAfterSessionRefresh,
  safeSupabaseMutationErrorMessage,
  safeSupabaseReadErrorMessage,
} from "./supabase-session";

describe("Supabase session read retry", () => {
  it("classifies only transient JWT synchronization errors", () => {
    expect(isSupabaseSessionSyncError({ message: "JWT issued at future" })).toBe(true);
    expect(isSupabaseSessionSyncError({ code: "PGRST301", message: "JWT expired" })).toBe(true);
    expect(isSupabaseSessionSyncError({ message: "permission denied for relation employees" })).toBe(false);
  });

  it("refreshes once and retries a batch when the first read has a stale JWT", async () => {
    const refreshSession = vi.fn().mockResolvedValue({ data: { session: {} }, error: null });
    const query = vi.fn()
      .mockResolvedValueOnce([{ error: { message: "JWT issued at future" } }])
      .mockResolvedValueOnce([{ error: null, data: [{ id: "employee-1" }] }]);

    const result = await retrySupabaseQueriesAfterSessionRefresh(
      { auth: { refreshSession } } as never,
      query,
    );

    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(2);
    expect(result[0]?.error).toBeNull();
  });

  it("shares one refresh flight when stale reads fail concurrently", async () => {
    let releaseRefresh: () => void = () => undefined;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const refreshSession = vi.fn(async () => {
      await refreshGate;
      return { data: { session: {} }, error: null };
    });
    let queryCount = 0;
    const query = vi.fn(async () => {
      queryCount += 1;
      return queryCount <= 2
        ? [{ error: { message: "JWT issued at future" } }]
        : [{ error: null, data: [{ id: "employee-1" }] }];
    });
    const client = { auth: { refreshSession } } as never;

    const first = retrySupabaseQueriesAfterSessionRefresh(client, query);
    const second = retrySupabaseQueriesAfterSessionRefresh(client, query);
    await Promise.resolve();
    releaseRefresh();
    await Promise.all([first, second]);

    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(4);
  });

  it("keeps a safe message for permission failures and never exposes raw details", () => {
    const message = safeSupabaseReadErrorMessage({ message: "permission denied: internal detail" });
    expect(message).toContain("資料暫時無法載入");
    expect(message).not.toContain("internal detail");
  });

  it("keeps mutation failures safe and retryable", () => {
    const message = safeSupabaseMutationErrorMessage({ message: "constraint detail" });
    expect(message).toContain("相同按鈕重試");
    expect(message).not.toContain("constraint detail");
  });
});
