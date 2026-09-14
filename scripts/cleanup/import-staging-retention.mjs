#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import pg from "pg";

const { Client } = pg;
const EXECUTE_CONFIRMATION = "PURGE_ELIGIBLE_IMPORT_STAGING";
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL_STATUSES = new Set(["FAILED", "CANCELLED"]);

function parseArguments(argv) {
  let execute = false;
  let limit = DEFAULT_LIMIT;
  for (const arg of argv) {
    if (arg === "--execute") {
      execute = true;
      continue;
    }
    if (arg.startsWith("--limit=")) {
      limit = Number(arg.slice("--limit=".length));
      continue;
    }
    throw new Error(`Unknown import staging retention argument: ${arg}`);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`Import staging retention limit must be an integer from 1 to ${MAX_LIMIT}.`);
  }
  return { execute, limit };
}

function requireDatabaseUrl(env) {
  const raw = env.IMPORT_RETENTION_DATABASE_URL;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("IMPORT_RETENTION_DATABASE_URL is required.");
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("IMPORT_RETENTION_DATABASE_URL must be a PostgreSQL URL.");
  }
  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol)) {
    throw new Error("IMPORT_RETENTION_DATABASE_URL must be a PostgreSQL URL.");
  }
  let username = "";
  try {
    username = decodeURIComponent(parsed.username);
  } catch {
    username = "";
  }
  if (username !== "job_import_retention") {
    throw new Error("IMPORT_RETENTION_DATABASE_URL must authenticate directly as job_import_retention.");
  }
  return raw;
}

function requireExecuteConfirmation(env) {
  if (env.IMPORT_RETENTION_EXECUTE_CONFIRM !== EXECUTE_CONFIRMATION) {
    throw new Error(`Execute mode requires IMPORT_RETENTION_EXECUTE_CONFIRM=${EXECUTE_CONFIRMATION}.`);
  }
}

function normalizeCount(value, fieldName) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Database returned an invalid ${fieldName}; refusing retention work.`);
  }
  return count;
}

function normalizeCandidate(row) {
  const candidate = {
    batchId: row.batch_id,
    batchNo: row.batch_no,
    status: row.status,
    terminalAt: row.terminal_at,
    stagingRowCount: normalizeCount(row.staging_row_count, "staging row count"),
    payloadRowCount: normalizeCount(row.payload_row_count, "payload row count"),
  };
  if (
    typeof candidate.batchId !== "string"
    || !UUID_RE.test(candidate.batchId)
    || typeof candidate.batchNo !== "string"
    || candidate.batchNo.trim() === ""
    || !TERMINAL_STATUSES.has(candidate.status)
    || candidate.terminalAt == null
  ) {
    throw new Error("Database returned an unsafe import staging retention candidate; refusing retention work.");
  }
  return candidate;
}

async function createDefaultDbClient(connectionString) {
  const client = new Client({ connectionString, application_name: "uniform-import-staging-retention" });
  await client.connect();
  return client;
}

async function listCandidates(db, limit) {
  const result = await db.query(
    "select * from public.list_import_staging_retention_candidates($1)",
    [limit],
  );
  return result.rows.map(normalizeCandidate);
}

async function purgeCandidate(db, candidate) {
  const result = await db.query(
    "select (public.purge_import_staging_payload($1)).staging_purged_at as staging_purged_at",
    [candidate.batchId],
  );
  if (result.rows[0]?.staging_purged_at == null) {
    throw new Error("Import staging retention RPC returned no purge marker.");
  }
}

function isNoLongerEligibleError(error) {
  return error && typeof error === "object" && (error.code === "55000" || error.code === "P0002");
}

export async function runImportStagingRetention(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;
  const createDbClient = options.createDbClient ?? createDefaultDbClient;
  const { execute, limit } = parseArguments(argv);
  const connectionString = requireDatabaseUrl(env);
  if (execute) requireExecuteConfirmation(env);

  const db = await createDbClient(connectionString);
  let purged = 0;
  let skipped = 0;
  let failed = 0;
  try {
    const candidates = await listCandidates(db, limit);
    const payloadRows = candidates.reduce((sum, candidate) => sum + candidate.payloadRowCount, 0);
    logger.log(`Import staging retention mode=${execute ? "execute" : "dry-run"}; candidates=${candidates.length}; payload_rows=${payloadRows}.`);

    if (!execute) {
      for (const candidate of candidates) {
        logger.log(`DRY-RUN ${candidate.status} ${candidate.batchNo} batch=${candidate.batchId} payload_rows=${candidate.payloadRowCount}`);
      }
      return { mode: "dry-run", candidates: candidates.length, payloadRows, purged, skipped, failed };
    }

    for (const candidate of candidates) {
      try {
        await purgeCandidate(db, candidate);
        purged += 1;
        logger.log(`PURGED ${candidate.status} ${candidate.batchNo} batch=${candidate.batchId} payload_rows=${candidate.payloadRowCount}`);
      } catch (error) {
        if (isNoLongerEligibleError(error)) {
          skipped += 1;
          logger.log(`SKIP no-longer-eligible batch=${candidate.batchId}`);
          continue;
        }
        failed += 1;
        logger.error(`FAILED batch=${candidate.batchId}`);
      }
    }

    logger.log(`Import staging retention summary: purged=${purged}, skipped=${skipped}, failed=${failed}.`);
    return { mode: "execute", candidates: candidates.length, payloadRows, purged, skipped, failed };
  } finally {
    await db.end();
  }
}

async function main() {
  try {
    const result = await runImportStagingRetention();
    if (result.failed > 0) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Import staging retention failed.";
    console.error(message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
