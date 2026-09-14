#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import pg from "pg";

const { Client } = pg;
const EXECUTE_CONFIRMATION = "DELETE_ELIGIBLE_STORAGE";
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SAFE_KEY_PATTERNS = new Map([
  ["uniform-imports", new RegExp(`^imports/${UUID_PATTERN}/${UUID_PATTERN}$`)],
  ["uniform-pdf", new RegExp(`^pdf/${UUID_PATTERN}(?:/[0-9]+)?$`)],
  ["uniform-erp", new RegExp(`^erp/${UUID_PATTERN}(?:/[0-9]+)?$`)],
]);

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
    throw new Error(`Unknown storage cleanup argument: ${arg}`);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`Storage cleanup limit must be an integer from 1 to ${MAX_LIMIT}.`);
  }
  return { execute, limit };
}

function requireDatabaseUrl(env) {
  const raw = env.CLEANUP_DATABASE_URL;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("CLEANUP_DATABASE_URL is required.");
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("CLEANUP_DATABASE_URL must be a PostgreSQL URL.");
  }
  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol)) {
    throw new Error("CLEANUP_DATABASE_URL must be a PostgreSQL URL.");
  }
  let username = "";
  try {
    username = decodeURIComponent(parsed.username);
  } catch {
    username = "";
  }
  if (username !== "job_storage_cleanup") {
    throw new Error("CLEANUP_DATABASE_URL must authenticate directly as job_storage_cleanup.");
  }
  return raw;
}

function requireExecuteConfiguration(env) {
  if (env.CLEANUP_EXECUTE_CONFIRM !== EXECUTE_CONFIRMATION) {
    throw new Error(`Execute mode requires CLEANUP_EXECUTE_CONFIRM=${EXECUTE_CONFIRMATION}.`);
  }
  if (typeof env.CLEANUP_SUPABASE_URL !== "string" || env.CLEANUP_SUPABASE_URL.trim() === "") {
    throw new Error("Execute mode requires CLEANUP_SUPABASE_URL.");
  }
  let url;
  try {
    url = new URL(env.CLEANUP_SUPABASE_URL);
  } catch {
    throw new Error("CLEANUP_SUPABASE_URL must be an HTTP(S) URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("CLEANUP_SUPABASE_URL must be an HTTP(S) URL.");
  }
  if (typeof env.CLEANUP_STORAGE_ADMIN_KEY !== "string" || env.CLEANUP_STORAGE_ADMIN_KEY.trim() === "") {
    throw new Error("Execute mode requires CLEANUP_STORAGE_ADMIN_KEY.");
  }
}

export function isSafeCleanupObject(bucketId, objectKey) {
  if (typeof bucketId !== "string" || typeof objectKey !== "string") return false;
  if (objectKey.startsWith("/") || objectKey.includes("..") || objectKey.includes("\\")) return false;
  return SAFE_KEY_PATTERNS.get(bucketId)?.test(objectKey) === true;
}

function normalizeCandidate(row) {
  return {
    candidateType: row.candidate_type,
    bucketId: row.bucket_id,
    objectKey: row.object_key,
    objectUpdatedAt: row.object_updated_at,
  };
}

function assertCandidateSafe(candidate) {
  if (typeof candidate.candidateType !== "string" || !isSafeCleanupObject(candidate.bucketId, candidate.objectKey)) {
    throw new Error("Database returned an unsafe storage cleanup candidate; refusing all deletion work.");
  }
}

async function createDefaultDbClient(connectionString) {
  const client = new Client({ connectionString, application_name: "uniform-storage-cleanup" });
  await client.connect();
  return client;
}

async function listCandidates(db, limit) {
  const result = await db.query(
    "select * from public.list_storage_cleanup_candidates($1)",
    [limit],
  );
  return result.rows.map(normalizeCandidate);
}

async function confirmCandidate(db, candidate) {
  const result = await db.query(
    "select public.confirm_storage_cleanup_candidate($1, $2) as candidate_type",
    [candidate.bucketId, candidate.objectKey],
  );
  return result.rows[0]?.candidate_type ?? null;
}

async function recordEvent(db, candidateType, candidate, outcome, details) {
  await db.query(
    "select public.record_storage_cleanup_event($1, $2, $3, $4, $5::jsonb)",
    [candidateType, candidate.bucketId, candidate.objectKey, outcome, JSON.stringify(details)],
  );
}

async function deleteStorageObject(fetchImpl, env, candidate) {
  const baseUrl = env.CLEANUP_SUPABASE_URL.replace(/\/+$/, "");
  const endpoint = `${baseUrl}/storage/v1/object/${encodeURIComponent(candidate.bucketId)}`;
  return fetchImpl(endpoint, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${env.CLEANUP_STORAGE_ADMIN_KEY}`,
      apikey: env.CLEANUP_STORAGE_ADMIN_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prefixes: [candidate.objectKey] }),
  });
}

export async function runStorageCleanup(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const createDbClient = options.createDbClient ?? createDefaultDbClient;
  const { execute, limit } = parseArguments(argv);
  const connectionString = requireDatabaseUrl(env);
  if (execute) requireExecuteConfiguration(env);

  const db = await createDbClient(connectionString);
  let failed = 0;
  let deleted = 0;
  let missing = 0;
  let skipped = 0;
  try {
    const candidates = await listCandidates(db, limit);
    for (const candidate of candidates) assertCandidateSafe(candidate);

    logger.log(`Storage cleanup mode=${execute ? "execute" : "dry-run"}; candidates=${candidates.length}.`);
    if (!execute) {
      for (const candidate of candidates) {
        logger.log(`DRY-RUN ${candidate.candidateType} ${candidate.bucketId}/${candidate.objectKey}`);
      }
      return { mode: "dry-run", candidates: candidates.length, deleted, missing, skipped, failed };
    }

    for (const candidate of candidates) {
      const confirmedType = await confirmCandidate(db, candidate);
      if (!confirmedType) {
        skipped += 1;
        logger.log(`SKIP no-longer-eligible ${candidate.bucketId}/${candidate.objectKey}`);
        continue;
      }
      const confirmed = { ...candidate, candidateType: confirmedType };
      assertCandidateSafe(confirmed);

      let response;
      try {
        response = await deleteStorageObject(fetchImpl, env, confirmed);
      } catch {
        failed += 1;
        await recordEvent(db, confirmedType, confirmed, "FAILED", { error: "STORAGE_REQUEST_FAILED" });
        logger.error(`FAILED storage request ${confirmed.bucketId}/${confirmed.objectKey}`);
        continue;
      }

      if (response.status === 404) {
        missing += 1;
        await recordEvent(db, confirmedType, confirmed, "ALREADY_MISSING", { http_status: 404 });
        logger.log(`ALREADY_MISSING ${confirmed.bucketId}/${confirmed.objectKey}`);
      } else if (response.ok) {
        deleted += 1;
        await recordEvent(db, confirmedType, confirmed, "DELETED", { http_status: response.status });
        logger.log(`DELETED ${confirmed.bucketId}/${confirmed.objectKey}`);
      } else {
        failed += 1;
        await recordEvent(db, confirmedType, confirmed, "FAILED", { http_status: response.status });
        logger.error(`FAILED http=${response.status} ${confirmed.bucketId}/${confirmed.objectKey}`);
      }
    }

    logger.log(`Storage cleanup summary: deleted=${deleted}, missing=${missing}, skipped=${skipped}, failed=${failed}.`);
    return { mode: "execute", candidates: candidates.length, deleted, missing, skipped, failed };
  } finally {
    await db.end();
  }
}

async function main() {
  try {
    const result = await runStorageCleanup();
    if (result.failed > 0) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Storage cleanup failed.";
    console.error(message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
