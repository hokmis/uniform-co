import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const manifestScript = join(process.cwd(), "scripts", "backup", "create-manifest.mjs");

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

describe("backup manifest", () => {
  it("records deterministic relative metadata while excluding manifest.json itself", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uniform-backup-manifest-"));
    try {
      const nestedDirectory = join(directory, "nested");
      await mkdir(nestedDirectory);
      await writeFile(join(directory, "z-last.txt"), "last\n", "utf8");
      await writeFile(join(nestedDirectory, "a-first.txt"), "first", "utf8");
      await writeFile(join(nestedDirectory, "manifest.json.lock"), "real nested payload", "utf8");
      await writeFile(join(directory, "manifest.json"), '{"stale":true}\n', "utf8");

      await execFileAsync(process.execPath, [manifestScript, directory]);

      const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as {
        schema: string;
        generatedAt: string;
        nodeVersion: string;
        files: Array<{ path: string; bytes: number; sha256: string }>;
      };

      expect(manifest.schema).toBe("uniform-co-backup-manifest-v1");
      expect(Number.isNaN(Date.parse(manifest.generatedAt))).toBe(false);
      expect(manifest.nodeVersion).toBe(process.version);
      expect(manifest.files).toEqual([
        {
          path: "nested/a-first.txt",
          bytes: 5,
          sha256: sha256("first"),
        },
        {
          path: "nested/manifest.json.lock",
          bytes: 19,
          sha256: sha256("real nested payload"),
        },
        {
          path: "z-last.txt",
          bytes: 5,
          sha256: sha256("last\n"),
        },
      ]);
      expect(manifest.files.some((file) => file.path === "manifest.json")).toBe(false);
      expect(manifest.files.every((file) => !isAbsolute(file.path))).toBe(true);
      expect(manifest.files.every((file) => !file.path.includes("\\"))).toBe(true);
      expect((await readdir(directory)).some((name) => name === "manifest.json.lock" || name.startsWith("manifest.json.tmp-"))).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed on an existing rebuild lock without changing the current manifest or stealing the lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uniform-backup-manifest-lock-"));
    try {
      await writeFile(join(directory, "payload.txt"), "payload\n", "utf8");
      await execFileAsync(process.execPath, [manifestScript, directory]);
      const before = await readFile(join(directory, "manifest.json"), "utf8");
      const lockPath = join(directory, "manifest.json.lock");
      await writeFile(lockPath, "held-by-other-rebuild\n", { encoding: "utf8", flag: "wx" });

      await expect(execFileAsync(process.execPath, [manifestScript, directory])).rejects.toThrow(
        /Another backup manifest rebuild is in progress/,
      );
      expect(await readFile(join(directory, "manifest.json"), "utf8")).toBe(before);
      expect(await readFile(lockPath, "utf8")).toBe("held-by-other-rebuild\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps scan-time source stability checks ahead of the atomic manifest replacement", async () => {
    const script = await readFile(manifestScript, "utf8");
    const beforeStatIndex = script.indexOf('const before = await stat(path, { bigint: true });');
    const digestIndex = script.indexOf("const sha256 = await digest(path);");
    const afterStatIndex = script.indexOf('const after = await stat(path, { bigint: true });');
    const stateCheckIndex = script.indexOf("if (!sameFileState(before, after))");
    const finalWalkIndex = script.indexOf("const finalPaths = (await walk(root))");
    const atomicWriteIndex = script.indexOf("await atomicWriteManifest({");

    expect(beforeStatIndex).toBeGreaterThanOrEqual(0);
    expect(beforeStatIndex).toBeLessThan(digestIndex);
    expect(digestIndex).toBeLessThan(afterStatIndex);
    expect(afterStatIndex).toBeLessThan(stateCheckIndex);
    expect(stateCheckIndex).toBeLessThan(finalWalkIndex);
    expect(finalWalkIndex).toBeLessThan(atomicWriteIndex);
  });

  it("fails closed when no backup run directory is configured", async () => {
    const env = { ...process.env };
    delete env.BACKUP_RUN_DIR;

    await expect(execFileAsync(process.execPath, [manifestScript], { env })).rejects.toThrow(
      /BACKUP_RUN_DIR is required/,
    );
  });
});
