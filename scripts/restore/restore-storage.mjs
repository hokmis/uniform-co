#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const runDir = resolve(process.env.BACKUP_RUN_DIR ?? "");
const validateOnly = process.argv.includes("--validate-only");
if (!runDir || runDir === resolve(".")) throw new Error("BACKUP_RUN_DIR is required");
const manifest = JSON.parse(await readFile(resolve(runDir, "storage-manifest.json"), "utf8"));
const allowedBuckets = new Set(["uniform-imports", "uniform-artifacts", "uniform-render-temp", "uniform-pdf", "uniform-erp"]);
if (manifest.schema !== "uniform-co-storage-manifest-v1") throw new Error("Unsupported Storage manifest schema");
if (
  !Array.isArray(manifest.buckets)
  || manifest.buckets.some((bucket) => !allowedBuckets.has(bucket))
  || new Set(manifest.buckets).size !== manifest.buckets.length
  || manifest.buckets.length !== allowedBuckets.size
  || [...allowedBuckets].some((bucket) => !manifest.buckets.includes(bucket))
) {
  throw new Error("Storage manifest must contain every approved bucket exactly once");
}
if (!Array.isArray(manifest.objects)) throw new Error("Storage manifest objects must be an array");

function safeObjectName(value) {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("/") || value.endsWith("/") || value.includes("\\")) return false;
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function validateObject(object) {
  if (!object?.bucket || !allowedBuckets.has(object.bucket) || !manifest.buckets.includes(object.bucket) || !safeObjectName(object.name)) {
    throw new Error("Storage manifest contains an unsafe object path");
  }
  const expectedRelativePath = `storage/${object.bucket}/${object.name}`;
  if (object.path !== expectedRelativePath) throw new Error("Storage manifest object path does not match bucket/name");
  if (!Number.isSafeInteger(object.bytes) || object.bytes < 0 || typeof object.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(object.sha256)) {
    throw new Error("Storage manifest contains invalid object metadata");
  }
  const path = resolve(runDir, object.path);
  if (!path.startsWith(runDir + "\\") && !path.startsWith(runDir + "/")) throw new Error("Storage manifest path escaped backup root");
  return path;
}

const objectTargets = new Set();
const objectPaths = manifest.objects.map((object) => {
  const target = `${object?.bucket ?? ""}/${object?.name ?? ""}`;
  if (objectTargets.has(target)) throw new Error("Storage manifest contains a duplicate object target");
  const path = validateObject(object);
  objectTargets.add(target);
  return path;
});

async function verifiedBytes(object, path) {
  const bytes = await readFile(path);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== object.sha256 || bytes.byteLength !== object.bytes) throw new Error(`Backup hash mismatch for ${object.bucket}/${object.name}`);
  return bytes;
}

if (validateOnly) {
  for (let index = 0; index < manifest.objects.length; index += 1) {
    await verifiedBytes(manifest.objects[index], objectPaths[index]);
  }
  console.log(`validated_storage_objects=${manifest.objects.length}`);
  process.exit(0);
}

if (!url || !serviceKey) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
async function request(path, options = {}) {
  return fetch(`${url.replace(/\/$/, "")}${path}`, { ...options, headers: { ...headers, ...(options.headers ?? {}) } });
}
async function api(path, options = {}) {
  const response = await request(path, options);
  if (!response.ok) throw new Error(`Storage restore failed (${response.status})`);
  return response;
}
async function ensurePrivateBucket(bucket) {
  const response = await request("/storage/v1/bucket", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: bucket, name: bucket, public: false }) });
  if (response.ok) return;
  if (response.status !== 409) throw new Error(`Storage restore failed (${response.status})`);

  const existing = await api(`/storage/v1/bucket/${encodeURIComponent(bucket)}`);
  const bucketInfo = await existing.json();
  if (bucketInfo?.public !== false) throw new Error(`Existing Storage bucket must be private: ${bucket}`);
}
function objectApiPath(object) {
  return `/storage/v1/object/${encodeURIComponent(object.bucket)}/${object.name.split("/").map(encodeURIComponent).join("/")}`;
}
async function verifyRestoredObject(object) {
  const response = await api(objectApiPath(object));
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== object.bytes || actual !== object.sha256) {
    throw new Error(`Restored Storage hash mismatch for ${object.bucket}/${object.name}`);
  }
}
for (const bucket of manifest.buckets ?? []) {
  await ensurePrivateBucket(bucket);
}
for (let index = 0; index < manifest.objects.length; index += 1) {
  const object = manifest.objects[index];
  const bytes = await verifiedBytes(object, objectPaths[index]);
  await api(objectApiPath(object), {
    method: "POST", headers: { "content-type": object.metadata?.mimetype ?? "application/octet-stream", "x-upsert": "false" }, body: bytes,
  });
  await verifyRestoredObject(object);
}
console.log(`restored_storage_objects=${manifest.objects.length}`);
console.log(`verified_storage_objects=${manifest.objects.length}`);
