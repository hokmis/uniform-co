import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const restoreScript = join(process.cwd(), "scripts", "restore", "restore-storage.mjs");
const approvedBuckets = ["uniform-imports", "uniform-artifacts", "uniform-render-temp", "uniform-pdf", "uniform-erp"];

function validationEnvironment(runDir: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, BACKUP_RUN_DIR: runDir };
  delete env.SUPABASE_URL;
  delete env.SUPABASE_SERVICE_ROLE_KEY;
  return env;
}

async function writeManifest(directory: string, manifest: unknown) {
  await writeFile(join(directory, "storage-manifest.json"), JSON.stringify({
    schema: "uniform-co-storage-manifest-v1",
    ...(manifest as Record<string, unknown>),
  }), "utf8");
}

async function expectValidationFailure(directory: string, manifest: unknown, pattern: RegExp) {
  await writeManifest(directory, manifest);
  await expect(
    execFileAsync(process.execPath, [restoreScript, "--validate-only"], { env: validationEnvironment(directory) }),
  ).rejects.toThrow(pattern);
}

describe("storage restore offline safety validation", () => {
  it("validates a complete local object without Supabase credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uniform-storage-restore-"));
    try {
      const storageDirectory = join(directory, "storage", "uniform-pdf");
      await mkdir(storageDirectory, { recursive: true });
      const contents = "verified backup bytes";
      await writeFile(join(storageDirectory, "document.pdf"), contents, "utf8");
      await writeManifest(directory, {
        buckets: approvedBuckets,
        objects: [{
          bucket: "uniform-pdf",
          name: "document.pdf",
          path: "storage/uniform-pdf/document.pdf",
          bytes: Buffer.byteLength(contents),
          sha256: createHash("sha256").update(contents).digest("hex"),
        }],
      });

      const result = await execFileAsync(process.execPath, [restoreScript, "--validate-only"], {
        env: validationEnvironment(directory),
      });

      expect(result.stdout).toContain("validated_storage_objects=1");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requires every approved bucket exactly once before any restore request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uniform-storage-restore-"));
    try {
      await expectValidationFailure(directory, { buckets: [...approvedBuckets, "public-files"], objects: [] }, /every approved bucket exactly once/);
      await expectValidationFailure(directory, { buckets: [...approvedBuckets, "uniform-pdf"], objects: [] }, /every approved bucket exactly once/);
      await expectValidationFailure(directory, { buckets: approvedBuckets.slice(0, -1), objects: [] }, /every approved bucket exactly once/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an unsupported manifest schema before any restore request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uniform-storage-restore-"));
    try {
      await expectValidationFailure(directory, { schema: "unknown", buckets: approvedBuckets, objects: [] }, /Unsupported Storage manifest schema/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects unsafe object names and backup paths before any restore request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uniform-storage-restore-"));
    try {
      await expectValidationFailure(directory, {
        buckets: approvedBuckets,
        objects: [{ bucket: "uniform-pdf", name: "../escape.pdf", path: "storage/uniform-pdf/escape.pdf", bytes: 0, sha256: "" }],
      }, /unsafe object path/);
      await expectValidationFailure(directory, {
        buckets: approvedBuckets,
        objects: [{ bucket: "uniform-pdf", name: "safe.pdf", path: "storage/uniform-erp/safe.pdf", bytes: 0, sha256: "0".repeat(64) }],
      }, /does not match bucket\/name/);
      await expectValidationFailure(directory, {
        buckets: approvedBuckets,
        objects: [{ bucket: "uniform-pdf", name: "folder\\safe.pdf", path: "storage/uniform-pdf/folder\\safe.pdf", bytes: 0, sha256: "0".repeat(64) }],
      }, /unsafe object path/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects duplicate restore targets before any restore request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uniform-storage-restore-"));
    try {
      const object = {
        bucket: "uniform-pdf",
        name: "document.pdf",
        path: "storage/uniform-pdf/document.pdf",
        bytes: 0,
        sha256: "0".repeat(64),
      };
      await expectValidationFailure(directory, {
        buckets: approvedBuckets,
        objects: [object, { ...object }],
      }, /duplicate object target/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a local object whose bytes do not match the manifest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uniform-storage-restore-"));
    try {
      const storageDirectory = join(directory, "storage", "uniform-pdf");
      await mkdir(storageDirectory, { recursive: true });
      await writeFile(join(storageDirectory, "document.pdf"), "tampered", "utf8");
      await expectValidationFailure(directory, {
        buckets: approvedBuckets,
        objects: [{
          bucket: "uniform-pdf",
          name: "document.pdf",
          path: "storage/uniform-pdf/document.pdf",
          bytes: 8,
          sha256: createHash("sha256").update("original").digest("hex"),
        }],
      }, /Backup hash mismatch/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reads each restored object back and verifies its bytes and hash", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uniform-storage-restore-"));
    const contents = "verified backup bytes";
    let readBackCount = 0;
    const server = createServer((request, response) => {
      if (request.method === "POST" && request.url === "/storage/v1/bucket") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      if (request.url === "/storage/v1/object/uniform-pdf/document.pdf") {
        if (request.method === "POST") {
          request.resume();
          request.on("end", () => {
            response.writeHead(200, { "content-type": "application/json" });
            response.end("{}");
          });
          return;
        }
        if (request.method === "GET") {
          readBackCount += 1;
          response.writeHead(200, { "content-type": "application/pdf" });
          response.end(contents);
          return;
        }
      }
      response.writeHead(404);
      response.end();
    });
    try {
      const storageDirectory = join(directory, "storage", "uniform-pdf");
      await mkdir(storageDirectory, { recursive: true });
      await writeFile(join(storageDirectory, "document.pdf"), contents, "utf8");
      await writeManifest(directory, {
        buckets: approvedBuckets,
        objects: [{
          bucket: "uniform-pdf",
          name: "document.pdf",
          path: "storage/uniform-pdf/document.pdf",
          bytes: Buffer.byteLength(contents),
          sha256: createHash("sha256").update(contents).digest("hex"),
        }],
      });

      await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Test server failed to bind");
      const result = await execFileAsync(process.execPath, [restoreScript], {
        env: {
          ...process.env,
          BACKUP_RUN_DIR: directory,
          SUPABASE_URL: `http://127.0.0.1:${address.port}`,
          SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
        },
      });

      expect(readBackCount).toBe(1);
      expect(result.stdout).toContain("restored_storage_objects=1");
      expect(result.stdout).toContain("verified_storage_objects=1");
    } finally {
      await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when target Storage read-back bytes do not match the manifest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uniform-storage-restore-"));
    const contents = "verified backup bytes";
    const server = createServer((request, response) => {
      if (request.method === "POST" && request.url === "/storage/v1/bucket") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      if (request.url === "/storage/v1/object/uniform-pdf/document.pdf") {
        if (request.method === "POST") {
          request.resume();
          request.on("end", () => {
            response.writeHead(200, { "content-type": "application/json" });
            response.end("{}");
          });
          return;
        }
        if (request.method === "GET") {
          response.writeHead(200, { "content-type": "application/pdf" });
          response.end("different target bytes");
          return;
        }
      }
      response.writeHead(404);
      response.end();
    });
    try {
      const storageDirectory = join(directory, "storage", "uniform-pdf");
      await mkdir(storageDirectory, { recursive: true });
      await writeFile(join(storageDirectory, "document.pdf"), contents, "utf8");
      await writeManifest(directory, {
        buckets: approvedBuckets,
        objects: [{
          bucket: "uniform-pdf",
          name: "document.pdf",
          path: "storage/uniform-pdf/document.pdf",
          bytes: Buffer.byteLength(contents),
          sha256: createHash("sha256").update(contents).digest("hex"),
        }],
      });

      await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Test server failed to bind");
      await expect(execFileAsync(process.execPath, [restoreScript], {
        env: {
          ...process.env,
          BACKUP_RUN_DIR: directory,
          SUPABASE_URL: `http://127.0.0.1:${address.port}`,
          SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
        },
      })).rejects.toThrow(/Restored Storage hash mismatch/);
    } finally {
      await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when an object already exists instead of treating upload conflict as restored", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uniform-storage-restore-"));
    const server = createServer((request, response) => {
      if (request.method === "POST" && request.url === "/storage/v1/bucket") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      if (request.method === "POST" && request.url === "/storage/v1/object/uniform-pdf/document.pdf") {
        response.writeHead(409, { "content-type": "application/json" });
        response.end('{"message":"already exists"}');
        return;
      }
      response.writeHead(404);
      response.end();
    });
    try {
      const storageDirectory = join(directory, "storage", "uniform-pdf");
      await mkdir(storageDirectory, { recursive: true });
      const contents = "verified backup bytes";
      await writeFile(join(storageDirectory, "document.pdf"), contents, "utf8");
      await writeManifest(directory, {
        buckets: approvedBuckets,
        objects: [{
          bucket: "uniform-pdf",
          name: "document.pdf",
          path: "storage/uniform-pdf/document.pdf",
          bytes: Buffer.byteLength(contents),
          sha256: createHash("sha256").update(contents).digest("hex"),
        }],
      });

      await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Test server failed to bind");
      await expect(execFileAsync(process.execPath, [restoreScript], {
        env: {
          ...process.env,
          BACKUP_RUN_DIR: directory,
          SUPABASE_URL: `http://127.0.0.1:${address.port}`,
          SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
        },
      })).rejects.toThrow(/Storage restore failed \(409\)/);
    } finally {
      await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a pre-existing public bucket when create returns a conflict", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uniform-storage-restore-"));
    const server = createServer((request, response) => {
      if (request.method === "POST" && request.url === "/storage/v1/bucket") {
        response.writeHead(409, { "content-type": "application/json" });
        response.end('{"message":"already exists"}');
        return;
      }
      if (request.method === "GET" && request.url?.startsWith("/storage/v1/bucket/")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"public":true}');
        return;
      }
      response.writeHead(404);
      response.end();
    });
    try {
      await writeManifest(directory, { buckets: approvedBuckets, objects: [] });
      await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Test server failed to bind");
      await expect(execFileAsync(process.execPath, [restoreScript], {
        env: {
          ...process.env,
          BACKUP_RUN_DIR: directory,
          SUPABASE_URL: `http://127.0.0.1:${address.port}`,
          SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
        },
      })).rejects.toThrow(/Existing Storage bucket must be private/);
    } finally {
      await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
      await rm(directory, { recursive: true, force: true });
    }
  });
});
