import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { parseBoundedImportFile, ImportParserError, type ParsedImportFile } from "../../src/domain/import-worker-parser.ts";
import { buildImportPreviewRows, type ImportPreviewRow, type ImportReferenceRow } from "../../src/domain/import-worker.ts";

const { Client } = pg;
const databaseUrl = process.env.IMPORT_WORKER_DATABASE_URL ?? process.env.DATABASE_URL;
const storageProxyUrl = process.env.IMPORT_STORAGE_PROXY_URL ?? process.env.RENDER_STORAGE_PROXY_URL;
const storageProxyToken = process.env.IMPORT_STORAGE_PROXY_TOKEN ?? process.env.RENDER_STORAGE_PROXY_TOKEN;
const leaseSeconds = Number(process.env.IMPORT_LEASE_SECONDS ?? 300);
const pollMilliseconds = Number(process.env.IMPORT_POLL_MS ?? 5000);
const once = process.argv.includes("--once");

if (!databaseUrl || !storageProxyUrl || !storageProxyToken) {
  throw new Error("IMPORT_WORKER_DATABASE_URL, IMPORT_STORAGE_PROXY_URL and IMPORT_STORAGE_PROXY_TOKEN are required");
}
if (!Number.isInteger(leaseSeconds) || leaseSeconds < 60 || leaseSeconds > 900) throw new Error("IMPORT_LEASE_SECONDS must be 60..900");
if (!Number.isInteger(pollMilliseconds) || pollMilliseconds < 100 || pollMilliseconds > 60000) throw new Error("IMPORT_POLL_MS must be 100..60000");

type ImportBatch = {
  id: string;
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

const encoder = new TextEncoder();
function comparePgJsonbKeys(left: string, right: string): number {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  if (leftBytes.length !== rightBytes.length) return leftBytes.length - rightBytes.length;
  for (let index = 0; index < Math.min(leftBytes.length, rightBytes.length); index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
  }
  return 0;
}
function pgJsonbText(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(pgJsonbText).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => comparePgJsonbKeys(left, right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}: ${pgJsonbText(child)}`).join(", ")}}`;
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  throw new TypeError("Unsupported fingerprint value");
}
function fingerprint(payload: unknown): string {
  return createHash("sha256").update(pgJsonbText(payload), "utf8").digest("hex");
}
function asNumber(value: string | number): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error("Database integer is outside the safe JavaScript range");
  return result;
}
function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const client = new Client({ connectionString: databaseUrl, application_name: "uniform-import-worker" });
await client.connect();

async function callRows<T>(name: string, args: unknown[]): Promise<T[]> {
  const placeholders = args.map((_, index) => `$${index + 1}`).join(",");
  const result = await client.query(`select * from public.${name}(${placeholders})`, args);
  return result.rows as T[];
}
async function callOne<T>(name: string, args: unknown[]): Promise<T | null> {
  const rows = await callRows<T>(name, args);
  return rows[0] ?? null;
}
async function scalar<T>(name: string, args: unknown[], alias: string): Promise<T> {
  const placeholders = args.map((_, index) => `$${index + 1}`).join(",");
  const result = await client.query(`select public.${name}(${placeholders}) as ${alias}`, args);
  return result.rows[0]?.[alias] as T;
}

async function downloadBatch(batch: ImportBatch): Promise<Uint8Array> {
  const path = batch.storage_object_key.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`${storageProxyUrl!.replace(/\/$/, "")}/download/${encodeURIComponent(batch.storage_bucket)}/${path}`, {
    headers: { authorization: `Bearer ${storageProxyToken}`, "x-batch-id": batch.id },
  });
  if (!response.ok) throw new Error(`Import Storage download failed (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== asNumber(batch.expected_size_bytes)) throw new Error("Import object size changed after confirmation");
  if (batch.file_sha256 && createHash("sha256").update(bytes).digest("hex") !== batch.file_sha256.toLowerCase()) throw new Error("Import object SHA-256 changed after confirmation");
  return bytes;
}

function flattenSheets(parsed: ParsedImportFile): string[][] {
  const populated = parsed.sheets.filter((sheet) => sheet.rows.length > 0);
  if (populated.length === 0) throw new ImportParserError("EMPTY_IMPORT", "Import workbook has no header/data rows");
  const header = populated[0].rows[0];
  const rows = [header, ...populated[0].rows.slice(1)];
  for (const sheet of populated.slice(1)) {
    if (JSON.stringify(sheet.rows[0]) !== JSON.stringify(header)) throw new ImportParserError("COLUMN_DRIFT", "Every XLSX sheet must use the same import header");
    rows.push(...sheet.rows.slice(1));
    if (rows.length > 10_001) throw new ImportParserError("ROW_LIMIT", "XLSX 總資料列數超過上限");
  }
  if (rows.length > 10_001) throw new ImportParserError("ROW_LIMIT", "XLSX 總資料列數超過上限");
  return rows;
}

async function previewRows(batch: ImportBatch): Promise<ImportPreviewRow[]> {
  const [bytes, reference] = await Promise.all([
    downloadBatch(batch),
    scalar<{ rows: ImportReferenceRow[] }>("get_import_reference_snapshot", [batch.id], "payload"),
  ]);
  const parsed = parseBoundedImportFile(bytes, batch.original_filename, batch.expected_mime_type);
  return buildImportPreviewRows(batch.import_type, flattenSheets(parsed), reference?.rows ?? []);
}

async function parsedRows(batch: ImportBatch): Promise<{ bytes: Uint8Array; rows: string[][] }> {
  const bytes = await downloadBatch(batch);
  const parsed = parseBoundedImportFile(bytes, batch.original_filename, batch.expected_mime_type);
  const rows = flattenSheets(parsed);
  if (rows.length < 2) throw new ImportParserError("EMPTY_IMPORT", "Import workbook has no data rows");
  return { bytes, rows };
}

async function confirmUpload(batch: ImportBatch): Promise<string> {
  const { bytes, rows } = await parsedRows(batch);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const payload = {
    batch_id: batch.id,
    mime: batch.expected_mime_type,
    size: bytes.byteLength,
    sha256,
    rows: rows.length - 1,
  };
  await callOne("confirm_import_upload", [
    batch.id,
    batch.expected_mime_type,
    bytes.byteLength,
    sha256,
    rows.length - 1,
    batch.upload_started_by,
    `IMPORT-CONFIRM-UPLOAD-${batch.id}`,
    fingerprint(payload),
  ]);
  return sha256;
}

async function failUpload(batch: ImportBatch, error: unknown): Promise<void> {
  const message = String(error instanceof Error ? error.message : error).slice(0, 500);
  const payload = { batch_id: batch.id, error_code: error instanceof ImportParserError ? error.code : "IMPORT_UPLOAD_INVALID", error_message: message };
  await callOne("fail_import_upload", [batch.id, payload.error_code, message, `IMPORT-FAIL-UPLOAD-${batch.id}`, fingerprint(payload)]);
}

async function failChunk(chunk: ImportChunk, error: unknown, retryable: boolean): Promise<void> {
  const code = error instanceof ImportParserError ? error.code : retryable ? "IMPORT_WORKER_RETRYABLE" : "IMPORT_WORKER_FAILED";
  const message = String(error instanceof Error ? error.message : error).slice(0, 500);
  const payload = {
    chunk_id: chunk.id,
    lease_generation: asNumber(chunk.lease_generation),
    cursor_version: asNumber(chunk.cursor_version),
    error_code: code,
    error_message: message,
    retryable,
  };
  await callOne("fail_import_chunk", [chunk.id, chunk.lease_token, chunk.lease_generation, chunk.cursor_version, code, message, retryable, `IMPORT-FAIL-${chunk.id}-${chunk.lease_generation}`, fingerprint(payload)]).catch(() => undefined);
}

async function processChunk(batch: ImportBatch, phase: "PARSE" | "VALIDATE"): Promise<void> {
  if (phase === "PARSE") await scalar<number>("prepare_import_chunks", [batch.id, phase], "prepared");
  const claimPayload = { batch_id: batch.id, phase, lease_seconds: leaseSeconds };
  const claimKey = `IMPORT-CLAIM-${batch.id}-${phase}-${randomUUID()}`;
  const chunk = await callOne<ImportChunk>("claim_import_chunk", [batch.id, phase, leaseSeconds, claimKey, fingerprint(claimPayload)]);
  if (!chunk?.id) return;
  try {
    const rows = await previewRows(batch);
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
    if (payloadRows.length !== end - start + 1) throw new Error(`Import chunk range ${start}-${end} does not match parsed rows`);
    const payload = { chunk_id: chunk.id, lease_generation: asNumber(chunk.lease_generation), cursor_version: asNumber(chunk.cursor_version), rows: payloadRows };
    await callOne("complete_import_chunk", [chunk.id, chunk.lease_token, chunk.lease_generation, chunk.cursor_version, JSON.stringify(payloadRows), `IMPORT-COMPLETE-${chunk.id}-${chunk.lease_generation}`, fingerprint(payload)]);
  } catch (error) {
    await failChunk(chunk, error, !(error instanceof ImportParserError));
  }
}

async function processApply(batch: ImportBatch): Promise<void> {
  if (!batch.confirmed_at) return;
  const claimPayload = { batch_id: batch.id, lease_seconds: leaseSeconds };
  const claimKey = `IMPORT-APPLY-CLAIM-${batch.id}-${randomUUID()}`;
  const claimed = await callOne<ImportBatch & { lease_token: string; lease_generation: string; cursor_version: string }>("claim_import_apply", [batch.id, leaseSeconds, claimKey, fingerprint(claimPayload)]);
  if (!claimed?.lease_token || claimed.status !== "APPLYING") return;
  const applyPayload = { batch_id: batch.id, lease_generation: asNumber(claimed.lease_generation), cursor_version: asNumber(claimed.cursor_version) };
  await callOne("apply_import_batch", [batch.id, claimed.lease_token, claimed.lease_generation, claimed.cursor_version, `IMPORT-APPLY-${batch.id}-${claimed.lease_generation}`, fingerprint(applyPayload)]);
}

async function processBatch(batch: ImportBatch): Promise<void> {
  if (batch.status === "AWAITING_UPLOAD") {
    try {
      const confirmedSha256 = await confirmUpload(batch);
      // Continue the same invocation after a successful confirmation. This
      // makes --once a useful single claim cycle while remaining safe when the
      // confirmation response is lost (the next poll sees the durable status).
      await processChunk({ ...batch, status: "UPLOADED", file_sha256: confirmedSha256 }, "PARSE");
    } catch (error) {
      if (error instanceof ImportParserError) await failUpload(batch, error);
      else throw error;
    }
  }
  else if (batch.status === "UPLOADED" || batch.status === "PARSING") await processChunk(batch, "PARSE");
  else if (batch.status === "VALIDATING") await processChunk(batch, "VALIDATE");
  else if (batch.status === "VALIDATED" || batch.status === "APPLYING") await processApply(batch);
}

try {
  do {
    const batches = await callRows<ImportBatch>("list_import_work", [10]);
    for (const batch of batches) {
      try {
        await processBatch(batch);
      } catch (error) {
        console.error(`[import-worker] batch ${batch.id}:`, error instanceof Error ? error.message : error);
      }
    }
    if (!once) await sleep(pollMilliseconds);
  } while (!once);
} finally {
  await client.end();
}
