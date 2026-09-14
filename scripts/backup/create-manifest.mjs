#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const root = resolve(process.argv[2] ?? process.env.BACKUP_RUN_DIR ?? "");
if (!root || root === resolve(".")) throw new Error("BACKUP_RUN_DIR is required");

const manifestPath = join(root, "manifest.json");
const lockPath = `${manifestPath}.lock`;
const temporaryPrefix = "manifest.json.tmp-";

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (
      directory === root
      && (
        entry.name === "manifest.json"
        || entry.name === "manifest.json.lock"
        || entry.name.startsWith(temporaryPrefix)
      )
    ) continue;
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

function sameFileState(before, after) {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs;
}

function normalizedRelativePath(path) {
  return relative(root, path).replaceAll("\\", "/");
}

async function atomicWriteManifest(value) {
  const temporaryPath = join(root, `${temporaryPrefix}${process.pid}-${randomUUID()}`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, manifestPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

let lockHandle;
try {
  try {
    lockHandle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error(
        "Another backup manifest rebuild is in progress; if no rebuild is running, inspect the stale manifest.json.lock before removing it",
      );
    }
    throw error;
  }

  const sourcePaths = await walk(root);
  const files = [];
  for (const path of sourcePaths) {
    const before = await stat(path, { bigint: true });
    const sha256 = await digest(path);
    const after = await stat(path, { bigint: true });
    if (!sameFileState(before, after)) {
      throw new Error(`Backup source changed while manifest was being built: ${normalizedRelativePath(path)}`);
    }
    if (after.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`Backup file is too large for manifest byte metadata: ${normalizedRelativePath(path)}`);
    }
    files.push({ path: normalizedRelativePath(path), bytes: Number(after.size), sha256 });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));

  const finalPaths = (await walk(root)).map(normalizedRelativePath).sort((left, right) => left.localeCompare(right));
  if (
    finalPaths.length !== files.length
    || finalPaths.some((path, index) => path !== files[index].path)
  ) {
    throw new Error("Backup file set changed while manifest was being built");
  }

  await atomicWriteManifest({
    schema: "uniform-co-backup-manifest-v1",
    generatedAt: new Date().toISOString(),
    nodeVersion: process.version,
    files,
  });
} finally {
  if (lockHandle) {
    try {
      await lockHandle.close();
    } finally {
      await rm(lockPath, { force: true });
    }
  }
}
