import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const validatorScript = join(process.cwd(), "scripts", "backup", "validate-run-id.mjs");
const storageExportScript = join(process.cwd(), "scripts", "backup", "export-storage.mjs");
const createManifestScript = join(process.cwd(), "scripts", "backup", "create-manifest.mjs");
const storageBuckets = "uniform-imports,uniform-artifacts,uniform-render-temp,uniform-pdf,uniform-erp";

async function validateRunId(runId: string) {
  return execFileAsync(process.execPath, [validatorScript, runId]);
}

describe("backup export safety gates", () => {
  it.each([
    "20260829T164500Z",
    "manual-20260829",
    "restore_check_01",
    "release.2026-08-29",
  ])("accepts safe backup run id %s", async (runId) => {
    const result = await validateRunId(runId);
    expect(result.stdout).toContain(`backup_run_id=${runId}`);
  });

  it.each([
    "../escape",
    "a/b",
    "a\\b",
    "with space",
    " leading",
    "line\nbreak",
    `a${"x".repeat(80)}`,
  ])("rejects unsafe backup run id %s", async (runId) => {
    await expect(validateRunId(runId)).rejects.toThrow();
  });

  it("validates run ids and dependencies before DB generation creation", async () => {
    const script = await readFile(join(process.cwd(), "scripts", "backup", "export-db.sh"), "utf8");
    const validatorIndex = script.indexOf('validate-run-id.mjs "${run_id}"');
    const pgDumpIndex = script.indexOf("command -v pg_dump");
    const psqlIndex = script.indexOf("command -v psql");
    const nodeIndex = script.indexOf("command -v node");
    const generationIndex = script.indexOf('mkdir -- "${BACKUP_ROOT}/${run_id}"');

    expect(validatorIndex).toBeGreaterThanOrEqual(0);
    expect(pgDumpIndex).toBeLessThan(generationIndex);
    expect(psqlIndex).toBeLessThan(generationIndex);
    expect(nodeIndex).toBeLessThan(generationIndex);
    expect(validatorIndex).toBeLessThan(generationIndex);
  });

  it("validates Auth run ids before resolving paths and refuses prior Auth output", async () => {
    const script = await readFile(join(process.cwd(), "scripts", "backup", "export-auth.sh"), "utf8");
    const validatorIndex = script.indexOf('validate-run-id.mjs "${run_id}"');
    const runDirectoryIndex = script.indexOf('cd -- "${BACKUP_ROOT}/${run_id}"');
    const overwriteGuardIndex = script.indexOf('[[ -e "${run_dir}/auth-data.sql" || -e "${run_dir}/auth-metadata.json" ]]');
    const dbPhaseGuardIndex = script.indexOf('[[ ! -f "${run_dir}/application.dump"');
    const manifestVerifyIndex = script.indexOf('verify-manifest.mjs "${run_dir}"');
    const dumpIndex = script.indexOf("pg_dump --data-only");

    expect(validatorIndex).toBeGreaterThanOrEqual(0);
    expect(validatorIndex).toBeLessThan(runDirectoryIndex);
    expect(overwriteGuardIndex).toBeGreaterThan(runDirectoryIndex);
    expect(overwriteGuardIndex).toBeLessThan(dumpIndex);
    expect(dbPhaseGuardIndex).toBeGreaterThan(overwriteGuardIndex);
    expect(dbPhaseGuardIndex).toBeLessThan(dumpIndex);
    expect(manifestVerifyIndex).toBeGreaterThan(dbPhaseGuardIndex);
    expect(manifestVerifyIndex).toBeLessThan(dumpIndex);
  });

  it("uses the shared validator for Storage and validates workflow input before persisting it", async () => {
    const storage = await readFile(join(process.cwd(), "scripts", "backup", "export-storage.mjs"), "utf8");
    const workflow = await readFile(join(process.cwd(), ".github", "workflows", "backup.yml"), "utf8");
    const workflowValidatorIndex = workflow.indexOf('node scripts/backup/validate-run-id.mjs "${BACKUP_RUN_ID}"');
    const persistIndex = workflow.indexOf('echo "BACKUP_RUN_ID=${BACKUP_RUN_ID}" >> "$GITHUB_ENV"');

    expect(storage).toContain('import { validateBackupRunId } from "./validate-run-id.mjs";');
    expect(storage.indexOf("validateBackupRunId(runId);")).toBeLessThan(storage.indexOf("const runDir = resolve(root, runId);"));
    expect(workflowValidatorIndex).toBeGreaterThanOrEqual(0);
    expect(workflowValidatorIndex).toBeLessThan(persistIndex);
  });

  it("refuses Storage export before network access when DB/Auth generation files are incomplete", async () => {
    const root = await mkdtemp(join(tmpdir(), "uniform-backup-storage-export-"));
    const runId = "safe-run-01";
    try {
      await mkdir(join(root, runId));
      await expect(execFileAsync(process.execPath, [storageExportScript], {
        env: {
          ...process.env,
          SUPABASE_URL: "https://example.invalid",
          SUPABASE_SERVICE_ROLE_KEY: "test-only-key",
          BACKUP_ROOT: root,
          BACKUP_RUN_ID: runId,
          BACKUP_STORAGE_BUCKETS: storageBuckets,
        },
      })).rejects.toThrow(/incomplete before Storage export: application\.dump/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to reuse a prior Storage export before network access", async () => {
    const root = await mkdtemp(join(tmpdir(), "uniform-backup-storage-export-"));
    const runId = "safe-run-02";
    const runDirectory = join(root, runId);
    try {
      await mkdir(runDirectory);
      for (const name of ["application.dump", "database-metadata.json", "tool-versions.txt", "auth-data.sql", "auth-metadata.json"]) {
        await writeFile(join(runDirectory, name), "test", "utf8");
      }
      await execFileAsync(process.execPath, [createManifestScript, runDirectory]);
      await mkdir(join(runDirectory, "storage"));

      await expect(execFileAsync(process.execPath, [storageExportScript], {
        env: {
          ...process.env,
          SUPABASE_URL: "https://example.invalid",
          SUPABASE_SERVICE_ROLE_KEY: "test-only-key",
          BACKUP_ROOT: root,
          BACKUP_RUN_ID: runId,
          BACKUP_STORAGE_BUCKETS: storageBuckets,
        },
      })).rejects.toThrow(/Refusing to overwrite existing Storage backup/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
