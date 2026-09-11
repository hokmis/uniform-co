import { describe, expect, it, vi } from "vitest";
import { isSafeCleanupObject, runStorageCleanup } from "../../scripts/cleanup/storage-cleanup.mjs";

const objectKey = "pdf/11111111-1111-1111-1111-111111111111/2";
const databaseUrl = "postgresql://job_storage_cleanup:SECRET_DB@localhost:5432/uniform";
const adminKey = "SECRET_STORAGE_ADMIN";

function logger() {
  return { log: vi.fn(), error: vi.fn() };
}

function fakeDb(options: { confirmType?: string | null; storageStatus?: number } = {}) {
  const events: unknown[][] = [];
  const queries: string[] = [];
  const db = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push(sql);
      if (sql.includes("list_storage_cleanup_candidates")) {
        return {
          rows: [{
            candidate_type: "EXPIRED_RENDER_LEASE_TEMP",
            bucket_id: "uniform-pdf",
            object_key: objectKey,
            object_updated_at: "2026-08-27T00:00:00Z",
          }],
        };
      }
      if (sql.includes("confirm_storage_cleanup_candidate")) {
        return { rows: [{ candidate_type: options.confirmType === undefined ? "EXPIRED_RENDER_LEASE_TEMP" : options.confirmType }] };
      }
      if (sql.includes("record_storage_cleanup_event")) {
        events.push(params ?? []);
        return { rows: [{}] };
      }
      throw new Error("unexpected query");
    }),
    end: vi.fn(async () => undefined),
  };
  return { db, events, queries };
}

function executeEnv() {
  return {
    CLEANUP_DATABASE_URL: databaseUrl,
    CLEANUP_EXECUTE_CONFIRM: "DELETE_ELIGIBLE_STORAGE",
    CLEANUP_SUPABASE_URL: "https://example.supabase.co",
    CLEANUP_STORAGE_ADMIN_KEY: adminKey,
  };
}

describe("storage cleanup runner", () => {
  it("defaults to dry-run and never sends a Storage DELETE", async () => {
    const state = fakeDb();
    const fetchImpl = vi.fn();
    const result = await runStorageCleanup({
      argv: [],
      env: { CLEANUP_DATABASE_URL: databaseUrl },
      logger: logger(),
      fetchImpl,
      createDbClient: async () => state.db,
    });

    expect(result.mode).toBe("dry-run");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(state.queries.some((query) => query.includes("confirm_storage_cleanup_candidate"))).toBe(false);
  });

  it("fails closed when --execute lacks the exact destructive confirmation", async () => {
    await expect(runStorageCleanup({
      argv: ["--execute"],
      env: { ...executeEnv(), CLEANUP_EXECUTE_CONFIRM: "NO" },
      logger: logger(),
      createDbClient: vi.fn(),
    })).rejects.toThrow("DELETE_ELIGIBLE_STORAGE");
  });

  it("rejects a database URL that is not the exact cleanup login", async () => {
    await expect(runStorageCleanup({
      argv: [],
      env: { CLEANUP_DATABASE_URL: "postgresql://postgres:SECRET@localhost/uniform" },
      logger: logger(),
      createDbClient: vi.fn(),
    })).rejects.toThrow("job_storage_cleanup");
  });

  it("rejects non-allowlisted buckets and unsafe object paths", () => {
    expect(isSafeCleanupObject("random-bucket", objectKey)).toBe(false);
    expect(isSafeCleanupObject("uniform-pdf", "../secret" )).toBe(false);
    expect(isSafeCleanupObject("uniform-pdf", "/pdf/11111111-1111-1111-1111-111111111111/2")).toBe(false);
    expect(isSafeCleanupObject("uniform-pdf", objectKey)).toBe(true);
  });

  it("rechecks every candidate immediately before Storage deletion", async () => {
    const state = fakeDb();
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }));
    await runStorageCleanup({
      argv: ["--execute"], env: executeEnv(), logger: logger(), fetchImpl,
      createDbClient: async () => state.db,
    });

    const confirmIndex = state.queries.findIndex((query) => query.includes("confirm_storage_cleanup_candidate"));
    expect(confirmIndex).toBeGreaterThan(-1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("skips deletion when the database recheck says the object is no longer eligible", async () => {
    const state = fakeDb({ confirmType: null });
    const fetchImpl = vi.fn();
    const result = await runStorageCleanup({
      argv: ["--execute"], env: executeEnv(), logger: logger(), fetchImpl,
      createDbClient: async () => state.db,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    expect(state.events).toHaveLength(0);
  });

  it("records HTTP 404 as idempotent ALREADY_MISSING", async () => {
    const state = fakeDb();
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404 }));
    const result = await runStorageCleanup({
      argv: ["--execute"], env: executeEnv(), logger: logger(), fetchImpl,
      createDbClient: async () => state.db,
    });

    expect(result.missing).toBe(1);
    expect(state.events[0]?.[3]).toBe("ALREADY_MISSING");
  });

  it("records non-2xx Storage failures without logging protected secrets", async () => {
    const state = fakeDb();
    const logs = logger();
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503 }));
    const result = await runStorageCleanup({
      argv: ["--execute"], env: executeEnv(), logger: logs, fetchImpl,
      createDbClient: async () => state.db,
    });

    expect(result.failed).toBe(1);
    expect(state.events[0]?.[3]).toBe("FAILED");
    const output = [...logs.log.mock.calls, ...logs.error.mock.calls].flat().join("\n");
    expect(output).not.toContain("SECRET_DB");
    expect(output).not.toContain(adminKey);
  });
});
