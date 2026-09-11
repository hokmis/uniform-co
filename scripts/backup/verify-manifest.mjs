#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

const root = resolve(process.argv[2] ?? process.env.BACKUP_RUN_DIR ?? "");
const forOffsite = process.argv.includes("--for-offsite");

if (!root || root === resolve(".")) throw new Error("BACKUP_RUN_DIR is required");

const sensitivePlaintextNames = new Set(["application.dump", "auth-data.sql"]);

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "manifest.json") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function digest(path) {
  const hash = createHash("sha256");
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

function safeManifestPath(value) {
  if (typeof value !== "string" || value.length === 0 || isAbsolute(value) || value.includes("\\")) return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
if (manifest?.schema !== "uniform-co-backup-manifest-v1" || !Array.isArray(manifest.files)) {
  throw new Error("Unsupported or invalid backup manifest");
}
if (forOffsite && manifest.files.length === 0) {
  throw new Error("Refusing offsite handoff for an empty backup generation");
}

const seen = new Set();
for (const file of manifest.files) {
  if (
    !safeManifestPath(file?.path)
    || !Number.isSafeInteger(file?.bytes)
    || file.bytes < 0
    || typeof file?.sha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(file.sha256)
    || seen.has(file.path)
  ) {
    throw new Error("Backup manifest contains invalid file metadata");
  }
  seen.add(file.path);
}

const manifestPaths = manifest.files.map((file) => file.path);
const sortedManifestPaths = [...manifestPaths].sort((left, right) => left.localeCompare(right));
if (manifestPaths.some((path, index) => path !== sortedManifestPaths[index])) {
  throw new Error("Backup manifest files must be sorted by path");
}

const actualPaths = (await walk(root))
  .map((path) => relative(root, path).replaceAll("\\", "/"))
  .sort((left, right) => left.localeCompare(right));
if (actualPaths.length !== manifestPaths.length || actualPaths.some((path, index) => path !== manifestPaths[index])) {
  throw new Error("Backup manifest does not match the generation file set");
}

for (const file of manifest.files) {
  if (forOffsite && sensitivePlaintextNames.has(basename(file.path))) {
    throw new Error(`Sensitive plaintext remains in backup generation: ${basename(file.path)}`);
  }
  const path = resolve(root, file.path);
  if (!path.startsWith(root + "\\") && !path.startsWith(root + "/")) {
    throw new Error("Backup manifest path escaped backup root");
  }
  const info = await stat(path);
  const sha256 = await digest(path);
  if (info.size !== file.bytes || sha256 !== file.sha256) {
    throw new Error(`Backup manifest integrity mismatch: ${file.path}`);
  }
}

console.log(`verified_backup_files=${manifest.files.length}`);
