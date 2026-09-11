#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { validateBackupRunId } from "./validate-run-id.mjs";

const execFileAsync = promisify(execFile);
const verifyManifestScript = fileURLToPath(new URL("./verify-manifest.mjs", import.meta.url));

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const root = resolve(process.env.BACKUP_ROOT ?? "");
const runId = process.env.BACKUP_RUN_ID;
const buckets = (process.env.BACKUP_STORAGE_BUCKETS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
const allowedBuckets = new Set(["uniform-imports", "uniform-artifacts", "uniform-render-temp", "uniform-pdf", "uniform-erp"]);
if (!url || !serviceKey || !process.env.BACKUP_ROOT || !runId || buckets.length === 0) {
  throw new Error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BACKUP_ROOT, BACKUP_RUN_ID and BACKUP_STORAGE_BUCKETS are required");
}
validateBackupRunId(runId);
if (buckets.some((bucket) => !allowedBuckets.has(bucket)) || new Set(buckets).size !== buckets.length || buckets.length !== allowedBuckets.size || [...allowedBuckets].some((bucket) => !buckets.includes(bucket))) {
  throw new Error(`BACKUP_STORAGE_BUCKETS must contain exactly: ${[...allowedBuckets].join(", ")}`);
}
const runDir = resolve(root, runId);
const storageRoot = resolve(runDir, "storage");
const storageManifestPath = join(runDir, "storage-manifest.json");
if (!storageRoot.startsWith(runDir + "\\") && !storageRoot.startsWith(runDir + "/")) throw new Error("Invalid backup path");

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

for (const requiredName of ["application.dump", "database-metadata.json", "tool-versions.txt", "auth-data.sql", "auth-metadata.json", "manifest.json"]) {
  const requiredPath = join(runDir, requiredName);
  let info;
  try {
    info = await stat(requiredPath);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Backup generation is incomplete before Storage export: ${requiredName}`);
    throw error;
  }
  if (!info.isFile()) throw new Error(`Backup generation is incomplete before Storage export: ${requiredName}`);
}
await execFileAsync(process.execPath, [verifyManifestScript, runDir]);
if (await pathExists(storageRoot) || await pathExists(storageManifestPath)) {
  throw new Error(`Refusing to overwrite existing Storage backup for generation: ${runId}`);
}
const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
const objects = [];

async function api(path, options = {}) {
  const response = await fetch(`${url.replace(/\/$/, "")}${path}`, { ...options, headers: { ...headers, ...(options.headers ?? {}) } });
  if (!response.ok) throw new Error(`Storage API failed (${response.status})`);
  return response;
}
for (const bucket of buckets) {
  const bucketResponse = await api(`/storage/v1/bucket/${encodeURIComponent(bucket)}`);
  const bucketInfo = await bucketResponse.json();
  if (bucketInfo?.public === true) throw new Error(`Storage bucket must be private: ${bucket}`);
  const prefixes = [""];
  for (let prefixIndex = 0; prefixIndex < prefixes.length; prefixIndex += 1) {
    const prefix = prefixes[prefixIndex];
    for (let offset = 0; ; offset += 1000) {
    const response = await api(`/storage/v1/object/list/${encodeURIComponent(bucket)}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: "name", order: "asc" } }),
    });
    const listed = await response.json();
    if (!Array.isArray(listed) || listed.length === 0) break;
    for (const entry of listed) {
      if (!entry?.name || entry.name.includes("..") || entry.name.startsWith("/")) throw new Error("Unsafe Storage object name");
      const name = String(entry.name);
      const fullName = `${prefix}${name}`;
      if (entry.id === null) {
        const childPrefix = `${fullName}/`;
        if (!prefixes.includes(childPrefix)) prefixes.push(childPrefix);
        continue;
      }
      const objectPath = resolve(storageRoot, bucket, fullName);
      if (!objectPath.startsWith(resolve(storageRoot, bucket) + "\\") && !objectPath.startsWith(resolve(storageRoot, bucket) + "/")) throw new Error("Storage path escaped backup root");
      const bytes = new Uint8Array(await (await api(`/storage/v1/object/${encodeURIComponent(bucket)}/${fullName.split("/").map(encodeURIComponent).join("/")}`)).arrayBuffer());
      await mkdir(dirname(objectPath), { recursive: true });
      await writeFile(objectPath, bytes, { flag: "wx", mode: 0o600 });
      objects.push({ bucket, name: fullName, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"), metadata: entry.metadata ?? null, path: relative(runDir, objectPath).replaceAll("\\", "/") });
    }
    if (listed.length < 1000) break;
  }
  }
}
await writeFile(storageManifestPath, `${JSON.stringify({ schema: "uniform-co-storage-manifest-v1", generatedAt: new Date().toISOString(), buckets, objects }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
console.log(`storage_objects=${objects.length}`);
