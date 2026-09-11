import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import pg from "pg";

const execFileAsync = promisify(execFile);
const { Client } = pg;
const cliKind = process.argv.find((value) => value.startsWith("--kind="))?.split("=", 2)[1];
const kind = (cliKind ?? process.env.RENDER_KIND) === "ERP" ? "ERP" : "PDF";
const dbUrl = process.env.DATABASE_URL;
const storageProxyUrl = process.env.RENDER_STORAGE_PROXY_URL;
const storageProxyToken = process.env.RENDER_STORAGE_PROXY_TOKEN;
const command = process.env.RENDER_COMMAND;
let commandArgs = [];
const leaseSeconds = Number(process.env.RENDER_LEASE_SECONDS ?? 300);

if (!dbUrl || !storageProxyUrl || !storageProxyToken || !command) {
  throw new Error("DATABASE_URL, RENDER_STORAGE_PROXY_URL, RENDER_STORAGE_PROXY_TOKEN and RENDER_COMMAND are required");
}
if (!/^https?:\/\//i.test(storageProxyUrl)) throw new Error("RENDER_STORAGE_PROXY_URL must be an HTTP(S) URL");
if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 900) throw new Error("RENDER_LEASE_SECONDS must be 30..900");
if (process.env.RENDER_COMMAND_ARGS) {
  try {
    const parsed = JSON.parse(process.env.RENDER_COMMAND_ARGS);
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) throw new Error("must be a JSON string array");
    commandArgs = parsed;
  } catch (error) {
    throw new Error(`RENDER_COMMAND_ARGS must be a JSON string array: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const client = new Client({ connectionString: dbUrl, application_name: `uniform-${kind.toLowerCase()}-renderer` });
await client.connect();
let attempt;
let timer;
let workDir;
async function readStorageInfo(bucket, objectKey) {
  const response = await fetch(`${storageProxyUrl.replace(/\/$/, "")}/info/${bucket}/${objectKey.split("/").map(encodeURIComponent).join("/")}`, {
    headers: { authorization: `Bearer ${storageProxyToken}`, "x-attempt-id": attempt.id, "x-lease-token": attempt.lease_token, "x-lease-generation": String(attempt.lease_generation) },
  });
  if (!response.ok) return null;
  return response.json();
}
try {
  const claimFn = kind === "PDF" ? "claim_document_render_attempt" : "claim_erp_render_attempt";
  const claimed = await client.query(`select * from public.${claimFn}($1)`, [leaseSeconds]);
  attempt = claimed.rows[0];
  if (!attempt?.id) process.exit(0);
  workDir = await mkdtemp(join(tmpdir(), `uniform-${kind.toLowerCase()}-${attempt.id}-`));
  const payloadPath = join(workDir, "payload.json");
  const outputPath = join(workDir, "render.out");
  const payloadFn = kind === "PDF" ? "get_document_render_payload" : "get_erp_render_payload";
  const payload = await client.query(`select public.${payloadFn}($1,$2,$3) as payload`, [attempt.id, attempt.lease_token, attempt.lease_generation]);
  await writeFile(payloadPath, `${JSON.stringify(payload.rows[0]?.payload ?? {})}\n`, { mode: 0o600 });
  const heartbeatFn = kind === "PDF" ? "heartbeat_document_render_attempt" : "heartbeat_erp_render_attempt";
  timer = setInterval(() => {
    void client.query(`select * from public.${heartbeatFn}($1,$2,$3,$4)`, [attempt.id, attempt.lease_token, attempt.lease_generation, leaseSeconds]).catch(() => process.exitCode = 1);
  }, Math.floor(leaseSeconds * 500));
  const adapterEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(DATABASE_URL|SUPABASE_|RENDER_|BACKUP_|GITHUB_|VERCEL_|TOKEN|SECRET|PASSWORD|API_KEY)/i.test(name)));
  await execFileAsync(command, [...commandArgs, "--attempt-id", attempt.id, "--payload", payloadPath, "--output", outputPath], { env: adapterEnv, maxBuffer: 1024 * 1024 });
  const bytes = await readFile(outputPath);
  const info = await stat(outputPath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const bucket = kind === "PDF" ? "uniform-pdf" : "uniform-erp";
  const objectKey = attempt.temp_object_key;
  let upload;
  let uploadError;
  try {
    upload = await fetch(`${storageProxyUrl.replace(/\/$/, "")}/upload/${bucket}/${objectKey.split("/").map(encodeURIComponent).join("/")}`, {
      method: "POST",
      headers: { authorization: `Bearer ${storageProxyToken}`, "x-attempt-id": attempt.id, "x-lease-token": attempt.lease_token, "x-lease-generation": String(attempt.lease_generation), "content-type": kind === "PDF" ? "application/pdf" : "text/plain", "x-metadata": Buffer.from(JSON.stringify({ sha256, size: String(info.size) })).toString("base64") },
      body: bytes,
    });
  } catch (error) {
    uploadError = error;
  }
  if (uploadError || !upload?.ok) {
    const existing = await readStorageInfo(bucket, objectKey);
    if (!existing) throw uploadError ?? new Error(`Storage upload failed (${upload?.status ?? "unknown"})`);
    const metadata = { ...(existing?.metadata ?? {}), ...(existing?.user_metadata ?? {}) };
    if (String(metadata.sha256 ?? "").toLowerCase() !== sha256 || Number(metadata.size) !== info.size) {
      throw new Error(`Reserved Storage object already exists with a different payload (${upload?.status ?? "unknown"})`);
    }
  }
  const finalizeFn = kind === "PDF" ? "finalize_document_render_attempt" : "finalize_erp_render_attempt";
  await client.query(`select * from public.${finalizeFn}($1,$2,$3,$4,$5,$6)`, [attempt.id, attempt.lease_token, attempt.lease_generation, objectKey, sha256, info.size]);
} catch (error) {
  if (attempt?.id) {
    // A conflicting object at the reserved key fences only this attempt.  The
    // database retry RPC creates a fresh attempt/key and applies max_attempts;
    // failing the whole artifact here would incorrectly discard a recoverable
    // same-snapshot render.
    const failFn = kind === "PDF" ? "retry_document_render_attempt" : "retry_erp_render_attempt";
    const errorCode = String(error?.message ?? error).includes("different payload") ? "RENDER_OBJECT_KEY_CONFLICT" : "RENDER_WORKER_FAILED";
    await client.query(`select * from public.${failFn}($1,$2,$3,$4,$5)`, [attempt.id, attempt.lease_token, attempt.lease_generation, errorCode, String(error?.message ?? error).slice(0, 500)]).catch(() => undefined);
  }
  throw error;
} finally {
  if (timer) clearInterval(timer);
  if (workDir) await rm(workDir, { recursive: true, force: true });
  await client.end();
}
