/* global Deno */
// This function is an on-demand serverless adapter for the existing durable
// import worker. It keeps the database state machine, worker actor and chunk
// fencing intact; it only replaces the always-on polling process.
import postgres from "npm:postgres@3.4.7";
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { parseBoundedImportFile, ImportParserError } from "../../../src/domain/import-worker-parser.ts";
import { buildImportPreviewRows, shouldImmediatelyContinueImportBatch, type ImportPreviewRow, type ImportReferenceRow } from "../../../src/domain/import-worker.ts";
import { flattenImportSheets, pgJsonbText } from "../../../src/domain/import-worker-core.ts";

type ImportBatch = {
  id: string;
  batch_no: string;
  import_type: "INSTITUTIONS" | "DEPARTMENTS" | "EMPLOYEES" | "UNIFORM_ITEMS" | "SUPPLIERS" | "SUPPLIER_ITEMS" | "OPENING_BALANCE";
  status: string;
  original_filename: string;
  expected_mime_type: string;
  expected_size_bytes: string | number;
  file_sha256: string | null;
  storage_bucket: string;
  storage_object_key: string;
  confirmed_at: string | null;
  max_attempts: number;
  upload_started_by: string;
  processing_cursor: string | number;
  cursor_version: string | number;
};

type ImportChunk = {
  id: string;
  batch_id: string;
  phase: "PARSE" | "VALIDATE";
  start_row_number: string | number;
  end_row_number: string | number;
  lease_token: string;
  lease_generation: string | number;
  cursor_version: string | number;
};

type SqlClient = ReturnType<typeof postgres>;

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };
const leaseSeconds = 120;
const maxChunksPerInvocation = 4;
const allowedOrigin = Deno.env.get("IMPORT_EDGE_ALLOWED_ORIGIN") ?? "https://uniform-co.vercel.app";

function responseBody(body: Record<string, unknown>, status = 200, request?: Request): Response {
  const headers = new Headers(jsonHeaders);
  const origin = request?.headers.get("origin");
  if (origin === allowedOrigin) headers.set("access-control-allow-origin", origin);
  headers.set("vary", "Origin");
  return new Response(JSON.stringify(body), { status, headers });
}

function safeErrorResponse(stage: string, status = 400, request?: Request): Response {
  return responseBody({ ok: false, diagnosticStage: stage }, status, request);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function asNumber(value: string | number): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error("Database integer is outside the safe JavaScript range");
  return result;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fingerprint(payload: unknown): Promise<string> {
  return sha256Hex(new TextEncoder().encode(pgJsonbText(payload)));
}

async function rpcRows<T>(sql: SqlClient, statement: string, args: readonly unknown[]): Promise<T[]> {
  return await sql.unsafe(statement, args as unknown[]) as T[];
}

async function rpcOne<T>(sql: SqlClient, statement: string, args: readonly unknown[]): Promise<T | null> {
  const rows = await rpcRows<T>(sql, statement, args);
  return rows[0] ?? null;
}

async function rpcScalar<T>(sql: SqlClient, statement: string, args: readonly unknown[]): Promise<T> {
  const rows = await rpcRows<Record<string, T>>(sql, statement, args);
  return rows[0]?.payload as T;
}

async function downloadBatch(storage: ReturnType<typeof createClient>, batch: ImportBatch): Promise<Uint8Array> {
  if (batch.storage_bucket !== "uniform-imports" || !batch.storage_object_key.startsWith(`imports/${batch.id}/`)) {
    throw new Error("Import storage capability is invalid");
  }
  const { data, error } = await storage.storage.from(batch.storage_bucket).download(batch.storage_object_key);
  if (error || !data) throw new Error("Import storage download failed");
  const bytes = new Uint8Array(await data.arrayBuffer());
  if (bytes.byteLength !== asNumber(batch.expected_size_bytes)) throw new Error("Import object size changed after confirmation");
  if (batch.file_sha256 && await sha256Hex(bytes) !== batch.file_sha256.toLowerCase()) throw new Error("Import object SHA-256 changed after confirmation");
  return bytes;
}

async function parsedRows(storage: ReturnType<typeof createClient>, batch: ImportBatch): Promise<{ bytes: Uint8Array; rows: string[][] }> {
  const bytes = await downloadBatch(storage, batch);
  const parsed = parseBoundedImportFile(bytes, batch.original_filename, batch.expected_mime_type);
  const rows = flattenImportSheets(parsed);
  if (rows.length < 2) throw new ImportParserError("EMPTY_IMPORT", "Import workbook has no data rows");
  return { bytes, rows };
}

async function previewRows(sql: SqlClient, storage: ReturnType<typeof createClient>, batch: ImportBatch): Promise<ImportPreviewRow[]> {
  const [file, reference] = await Promise.all([
    parsedRows(storage, batch),
    rpcScalar<{ rows: ImportReferenceRow[] }>(sql, "select public.get_import_reference_snapshot($1) as payload", [batch.id]),
  ]);
  return buildImportPreviewRows(batch.import_type, file.rows, reference?.rows ?? []);
}

async function confirmUpload(sql: SqlClient, storage: ReturnType<typeof createClient>, batch: ImportBatch): Promise<string> {
  const { bytes, rows } = await parsedRows(storage, batch);
  const sha256 = await sha256Hex(bytes);
  const payload = { batch_id: batch.id, mime: batch.expected_mime_type, size: bytes.byteLength, sha256, rows: rows.length - 1 };
  await rpcOne(sql, "select * from public.confirm_import_upload($1,$2,$3,$4,$5,$6,$7,$8)", [
    batch.id,
    batch.expected_mime_type,
    bytes.byteLength,
    sha256,
    rows.length - 1,
    batch.upload_started_by,
    `IMPORT-CONFIRM-UPLOAD-${batch.id}`,
    await fingerprint(payload),
  ]);
  return sha256;
}

async function failUpload(sql: SqlClient, batch: ImportBatch, error: unknown): Promise<void> {
  const errorCode = error instanceof ImportParserError ? error.code : "IMPORT_UPLOAD_INVALID";
  const message = error instanceof ImportParserError ? error.message : "The uploaded file could not be verified";
  const payload = { batch_id: batch.id, error_code: errorCode, error_message: message };
  await rpcOne(sql, "select * from public.fail_import_upload($1,$2,$3,$4,$5)", [
    batch.id,
    errorCode,
    message.slice(0, 500),
    `IMPORT-FAIL-UPLOAD-${batch.id}`,
    await fingerprint(payload),
  ]).catch(() => undefined);
}

async function failChunk(sql: SqlClient, chunk: ImportChunk, error: unknown, retryable: boolean): Promise<void> {
  const code = error instanceof ImportParserError ? error.code : retryable ? "IMPORT_WORKER_RETRYABLE" : "IMPORT_WORKER_FAILED";
  const message = error instanceof ImportParserError ? error.message : "Import chunk processing failed";
  const payload = {
    chunk_id: chunk.id,
    lease_generation: asNumber(chunk.lease_generation),
    cursor_version: asNumber(chunk.cursor_version),
    error_code: code,
    error_message: message,
    retryable,
  };
  await rpcOne(sql, "select * from public.fail_import_chunk($1,$2,$3,$4,$5,$6,$7,$8,$9)", [
    chunk.id,
    chunk.lease_token,
    chunk.lease_generation,
    chunk.cursor_version,
    code,
    message.slice(0, 500),
    retryable,
    `IMPORT-FAIL-${chunk.id}-${chunk.lease_generation}`,
    await fingerprint(payload),
  ]).catch(() => undefined);
}

type ProcessChunkResult = {
  claimed: boolean;
  continuePhase: boolean;
  completed: boolean;
  nextStatus: string | null;
  preview: ImportPreviewRow[] | null;
};

async function processChunk(
  sql: SqlClient,
  storage: ReturnType<typeof createClient>,
  batch: ImportBatch,
  phase: "PARSE" | "VALIDATE",
  cachedPreview: ImportPreviewRow[] | null,
): Promise<ProcessChunkResult> {
  if (phase === "PARSE") await rpcScalar(sql, "select public.prepare_import_chunks($1,$2) as payload", [batch.id, phase]);
  const claimPayload = { batch_id: batch.id, phase, lease_seconds: leaseSeconds };
  const chunk = await rpcOne<ImportChunk>(sql, "select * from public.claim_import_chunk($1,$2,$3,$4,$5)", [
    batch.id,
    phase,
    leaseSeconds,
    `IMPORT-CLAIM-${batch.id}-${phase}-${crypto.randomUUID()}`,
    await fingerprint(claimPayload),
  ]);
  if (!chunk?.id) return { claimed: false, continuePhase: false, completed: false, nextStatus: null, preview: cachedPreview };
  try {
    const rows = cachedPreview ?? await previewRows(sql, storage, batch);
    const start = asNumber(chunk.start_row_number);
    const end = asNumber(chunk.end_row_number);
    const payloadRows = rows.slice(start - 1, end).map((row) => ({
      row_number: row.row_number,
      raw_values: row.raw_values,
      normalized_values: row.normalized_values,
      proposed_action: row.proposed_action,
      validation_errors: row.validation_errors,
      diffs: row.diffs,
    }));
    if (payloadRows.length !== end - start + 1) throw new Error("Import chunk range does not match parsed rows");
    const payload = { chunk_id: chunk.id, lease_generation: asNumber(chunk.lease_generation), cursor_version: asNumber(chunk.cursor_version), rows: payloadRows };
    await rpcOne(sql, "select * from public.complete_import_chunk($1,$2,$3,$4,$5,$6,$7)", [
      chunk.id,
      chunk.lease_token,
      chunk.lease_generation,
      chunk.cursor_version,
      JSON.stringify(payloadRows),
      `IMPORT-COMPLETE-${chunk.id}-${chunk.lease_generation}`,
      await fingerprint(payload),
    ]);
    const nextStatus = await rpcOne<{ status: string }>(sql, "select status from public.import_batches where id = $1", [batch.id]);
    const continuePhase = phase === "PARSE" ? nextStatus?.status === "PARSING" : nextStatus?.status === "VALIDATING";
    return { claimed: true, continuePhase, completed: true, nextStatus: nextStatus?.status ?? null, preview: rows };
  } catch (error) {
    await failChunk(sql, chunk, error, !(error instanceof ImportParserError));
    return { claimed: true, continuePhase: false, completed: false, nextStatus: null, preview: cachedPreview };
  }
}

async function processApply(sql: SqlClient, batch: ImportBatch): Promise<void> {
  if (!batch.confirmed_at) return;
  const claimPayload = { batch_id: batch.id, lease_seconds: leaseSeconds };
  const claimed = await rpcOne<ImportBatch & { lease_token: string; lease_generation: string; cursor_version: string }>(sql, "select * from public.claim_import_apply($1,$2,$3,$4)", [
    batch.id,
    leaseSeconds,
    `IMPORT-APPLY-CLAIM-${batch.id}-${crypto.randomUUID()}`,
    await fingerprint(claimPayload),
  ]);
  if (!claimed?.lease_token || claimed.status !== "APPLYING") return;
  const applyPayload = { batch_id: batch.id, lease_generation: asNumber(claimed.lease_generation), cursor_version: asNumber(claimed.cursor_version) };
  await rpcOne(sql, "select * from public.apply_import_batch($1,$2,$3,$4,$5,$6)", [
    batch.id,
    claimed.lease_token,
    claimed.lease_generation,
    claimed.cursor_version,
    `IMPORT-APPLY-${batch.id}-${claimed.lease_generation}`,
    await fingerprint(applyPayload),
  ]);
}

async function processPhaseChunks(
  sql: SqlClient,
  storage: ReturnType<typeof createClient>,
  batch: ImportBatch,
  phase: "PARSE" | "VALIDATE",
): Promise<{ completedChunks: number; lastChunkCompleted: boolean; nextStatus: string | null }> {
  let result: ProcessChunkResult = { claimed: true, continuePhase: true, completed: false, nextStatus: null, preview: null };
  let completedChunks = 0;
  for (let count = 0; count < maxChunksPerInvocation && result.claimed && result.continuePhase; count += 1) {
    result = await processChunk(sql, storage, batch, phase, result.preview);
    if (result.completed) completedChunks += 1;
  }
  return {
    completedChunks,
    lastChunkCompleted: result.completed,
    nextStatus: result.nextStatus,
  };
}

async function processBatch(sql: SqlClient, storage: ReturnType<typeof createClient>, batch: ImportBatch): Promise<boolean> {
  if (batch.status === "AWAITING_UPLOAD") {
    try {
      const confirmedSha256 = await confirmUpload(sql, storage, batch);
      const progress = await processPhaseChunks(sql, storage, { ...batch, status: "UPLOADED", file_sha256: confirmedSha256 }, "PARSE");
      return shouldImmediatelyContinueImportBatch({ phase: "PARSE", chunkLimit: maxChunksPerInvocation, ...progress });
    } catch (error) {
      if (error instanceof ImportParserError) await failUpload(sql, batch, error);
      else throw error;
      return false;
    }
  } else if (batch.status === "UPLOADED" || batch.status === "PARSING") {
    const progress = await processPhaseChunks(sql, storage, batch, "PARSE");
    return shouldImmediatelyContinueImportBatch({ phase: "PARSE", chunkLimit: maxChunksPerInvocation, ...progress });
  } else if (batch.status === "VALIDATING") {
    const progress = await processPhaseChunks(sql, storage, batch, "VALIDATE");
    return shouldImmediatelyContinueImportBatch({ phase: "VALIDATE", chunkLimit: maxChunksPerInvocation, ...progress });
  } else if (batch.status === "VALIDATED" || batch.status === "APPLYING") {
    await processApply(sql, batch);
  }
  return false;
}

async function handleRequest(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") {
    const headers = new Headers({ ...jsonHeaders, "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "POST, OPTIONS" });
    if (request.headers.get("origin") === allowedOrigin) headers.set("access-control-allow-origin", allowedOrigin);
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== "POST") return safeErrorResponse("edge_import_method_not_allowed", 405, request);
  if (request.headers.get("origin") && request.headers.get("origin") !== allowedOrigin) return safeErrorResponse("edge_import_origin_rejected", 403, request);

  const authorization = request.headers.get("authorization");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const databaseUrl = Deno.env.get("IMPORT_EDGE_DATABASE_URL");
  if (!authorization?.startsWith("Bearer ") || !supabaseUrl || !anonKey || !databaseUrl) {
    return safeErrorResponse("edge_import_configuration_failed", 503, request);
  }

  const authClient = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: authorization } },
  });
  const { data: userData, error: userError } = await authClient.auth.getUser(authorization.slice("Bearer ".length));
  if (userError || !userData.user) return safeErrorResponse("edge_import_authentication_failed", 401, request);

  let body: unknown;
  try { body = await request.json(); } catch { return safeErrorResponse("edge_import_request_invalid", 400, request); }
  const batchId = (body as { batchId?: unknown } | null)?.batchId;
  if (!isUuid(batchId)) return safeErrorResponse("edge_import_request_invalid", 400, request);

  const { data: account, error: accountError } = await authClient.from("app_accounts").select("id").eq("auth_user_id", userData.user.id).maybeSingle();
  if (accountError) return safeErrorResponse("edge_import_account_query_failed", 503, request);
  if (!account?.id) return safeErrorResponse("edge_import_account_missing", 403, request);

  const sql = postgres(databaseUrl, { prepare: false, max: 1, idle_timeout: 5, connect_timeout: 10, connection: { application_name: "uniform-import-edge" } });
  const storage = authClient;
  try {
    const batches = await rpcRows<ImportBatch>(sql, "select * from public.list_import_work($1)", [50]);
    const batch = batches.find((candidate) => candidate.id === batchId);
    if (!batch) return responseBody({ ok: true, batchId, status: "NOT_PENDING" }, 200, request);
    if (batch.upload_started_by !== account.id) return safeErrorResponse("edge_import_access_denied", 403, request);
    const immediateWorkRemains = await processBatch(sql, storage, batch);
    const next = (await rpcRows<ImportBatch>(sql, "select * from public.list_import_work($1)", [50])).find((candidate) => candidate.id === batchId);
    const status = next?.status ?? "DONE";
    const continueImmediately = immediateWorkRemains && (status === "PARSING" || status === "VALIDATING");
    return responseBody({ ok: true, batchId, status, continueImmediately }, 200, request);
  } catch (error) {
    // Keep platform logs and browser responses free of database text, tokens and
    // object keys. Durable RPCs retain their own bounded error evidence.
    console.error("edge_import_processing_failed", error instanceof ImportParserError ? error.code : "runtime");
    return safeErrorResponse(error instanceof ImportParserError ? "edge_import_parser_failed" : "edge_import_processing_failed", 503, request);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

Deno.serve(handleRequest);
