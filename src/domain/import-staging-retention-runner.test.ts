import { describe, expect, it, vi } from "vitest";
import { runImportStagingRetention } from "../../scripts/cleanup/import-staging-retention.mjs";

const databaseUrl = "postgresql://job_import_retention:SECRET_DB@localhost:5432/uniform";
const batchId = "11111111-1111-4111-8111-111111111111";

function logger() {
  return { log: vi.fn(), error: vi.fn() };
}

function fakeDb(options: { purgeErrorCode?: string; malformed?: boolean } = {}) {
  const queries: string[] = [];
  const db = {
    query: vi.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.includes("list_import_staging_retention_candidates")) {
        return {
          rows: [{
            batch_id: options.malformed ? "../unsafe" : batchId,
            batch_no: "IMP-2026-0001",
            status: "FAILED",
            terminal_at: "2026-05-01T00:00:00Z",
            staging_row_count: "10",
            payload_row_count: "7",
          }],
        };
      }
      if (sql.includes("purge_import_staging_payload")) {
        if (options.purgeErrorCode) {
          const error = Object.assign(new Error("purge rejected"), { code: options.purgeErrorCode });
          throw error;
        }
        return { rows: [{ staging_purged_at: "2026-08-29T00:00:00Z" }] };
      }
      throw new Error("unexpected query");
    }),
    end: vi.fn(async () => undefined),
  };
  return { db, queries };
}

describe("import staging retention runner", () => {
  it("defaults to dry-run and never calls the purge RPC", async () => {
    const state = fakeDb();
    const result = await runImportStagingRetention({
      argv: [],
      env: { IMPORT_RETENTION_DATABASE_URL: databaseUrl },
      logger: logger(),
      createDbClient: async () => state.db,
    });

    expect(result).toMatchObject({ mode: "dry-run", candidates: 1, payloadRows: 7, purged: 0 });
    expect(state.queries.some((query) => query.includes("purge_import_staging_payload"))).toBe(false);
  });

  it("requires the exact job_import_retention login", async () => {
    await expect(runImportStagingRetention({
      argv: [],
      env: { IMPORT_RETENTION_DATABASE_URL: "postgresql://postgres:SECRET@localhost/uniform" },
      logger: logger(),
      createDbClient: vi.fn(),
    })).rejects.toThrow("job_import_retention");
  });

  it("requires explicit confirmation before execute mode", async () => {
    await expect(runImportStagingRetention({
      argv: ["--execute"],
      env: { IMPORT_RETENTION_DATABASE_URL: databaseUrl },
      logger: logger(),
      createDbClient: vi.fn(),
    })).rejects.toThrow("PURGE_ELIGIBLE_IMPORT_STAGING");
  });

  it("purges only through the database RPC and reports the batch", async () => {
    const state = fakeDb();
    const logs = logger();
    const result = await runImportStagingRetention({
      argv: ["--execute"],
      env: {
        IMPORT_RETENTION_DATABASE_URL: databaseUrl,
        IMPORT_RETENTION_EXECUTE_CONFIRM: "PURGE_ELIGIBLE_IMPORT_STAGING",
      },
      logger: logs,
      createDbClient: async () => state.db,
    });

    expect(result).toMatchObject({ mode: "execute", purged: 1, skipped: 0, failed: 0 });
    expect(state.queries.filter((query) => query.includes("purge_import_staging_payload"))).toHaveLength(1);
    const output = [...logs.log.mock.calls, ...logs.error.mock.calls].flat().join("\n");
    expect(output).not.toContain("SECRET_DB");
  });

  it("treats a DB recheck rejection as no-longer-eligible instead of widening eligibility", async () => {
    const state = fakeDb({ purgeErrorCode: "55000" });
    const result = await runImportStagingRetention({
      argv: ["--execute"],
      env: {
        IMPORT_RETENTION_DATABASE_URL: databaseUrl,
        IMPORT_RETENTION_EXECUTE_CONFIRM: "PURGE_ELIGIBLE_IMPORT_STAGING",
      },
      logger: logger(),
      createDbClient: async () => state.db,
    });

    expect(result).toMatchObject({ purged: 0, skipped: 1, failed: 0 });
  });

  it("fails closed when the candidate shape is unsafe", async () => {
    const state = fakeDb({ malformed: true });
    await expect(runImportStagingRetention({
      argv: [],
      env: { IMPORT_RETENTION_DATABASE_URL: databaseUrl },
      logger: logger(),
      createDbClient: async () => state.db,
    })).rejects.toThrow("unsafe import staging retention candidate");
    expect(state.db.end).toHaveBeenCalledTimes(1);
  });
});
