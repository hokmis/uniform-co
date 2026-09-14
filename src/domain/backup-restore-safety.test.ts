import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const createManifestScript = join(process.cwd(), "scripts", "backup", "create-manifest.mjs");
const verifyManifestScript = join(process.cwd(), "scripts", "backup", "verify-manifest.mjs");
const verifyRestoreMetadataScript = join(process.cwd(), "scripts", "restore", "verify-metadata.mjs");

async function createManifest(directory: string) {
  await execFileAsync(process.execPath, [createManifestScript, directory]);
}

describe("backup and restore safety gates", () => {
  it("verifies an unchanged backup generation and rejects byte tampering", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uniform-backup-verify-"));
    try {
      await writeFile(join(directory, "encrypted-backup.bin"), "ciphertext", "utf8");
      await createManifest(directory);

      const result = await execFileAsync(process.execPath, [verifyManifestScript, directory, "--for-offsite"]);
      expect(result.stdout).toContain("verified_backup_files=1");

      await writeFile(join(directory, "encrypted-backup.bin"), "tampered", "utf8");
      await expect(
        execFileAsync(process.execPath, [verifyManifestScript, directory, "--for-offsite"]),
      ).rejects.toThrow(/integrity mismatch/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects added files that are absent from the generation manifest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uniform-backup-verify-"));
    try {
      await writeFile(join(directory, "encrypted-backup.bin"), "ciphertext", "utf8");
      await createManifest(directory);
      await writeFile(join(directory, "unexpected.txt"), "not-in-manifest", "utf8");

      await expect(
        execFileAsync(process.execPath, [verifyManifestScript, directory]),
      ).rejects.toThrow(/does not match the generation file set/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses offsite handoff while sensitive plaintext dumps remain", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uniform-backup-verify-"));
    try {
      await writeFile(join(directory, "application.dump"), "database", "utf8");
      await writeFile(join(directory, "auth-data.sql"), "auth", "utf8");
      await createManifest(directory);

      await expect(
        execFileAsync(process.execPath, [verifyManifestScript, directory, "--for-offsite"]),
      ).rejects.toThrow(/Sensitive plaintext remains/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses offsite handoff for an empty generation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uniform-backup-verify-"));
    try {
      await createManifest(directory);
      await expect(
        execFileAsync(process.execPath, [verifyManifestScript, directory, "--for-offsite"]),
      ).rejects.toThrow(/empty backup generation/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects unsafe, duplicate, or unsorted manifest file metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uniform-backup-verify-"));
    try {
      const sha256 = createHash("sha256").update("x").digest("hex");
      await writeFile(join(directory, "a.txt"), "x", "utf8");
      const manifestPath = join(directory, "manifest.json");

      await writeFile(manifestPath, JSON.stringify({
        schema: "uniform-co-backup-manifest-v1",
        files: [{ path: "../escape.txt", bytes: 1, sha256 }],
      }), "utf8");
      await expect(execFileAsync(process.execPath, [verifyManifestScript, directory])).rejects.toThrow(/invalid file metadata/);

      await writeFile(manifestPath, JSON.stringify({
        schema: "uniform-co-backup-manifest-v1",
        files: [
          { path: "a.txt", bytes: 1, sha256 },
          { path: "a.txt", bytes: 1, sha256 },
        ],
      }), "utf8");
      await expect(execFileAsync(process.execPath, [verifyManifestScript, directory])).rejects.toThrow(/invalid file metadata/);

      await writeFile(join(directory, "b.txt"), "x", "utf8");
      await writeFile(manifestPath, JSON.stringify({
        schema: "uniform-co-backup-manifest-v1",
        files: [
          { path: "b.txt", bytes: 1, sha256 },
          { path: "a.txt", bytes: 1, sha256 },
        ],
      }), "utf8");
      await expect(execFileAsync(process.execPath, [verifyManifestScript, directory])).rejects.toThrow(/sorted by path/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps backup workflow manual and restore confirmation ahead of destructive commands", async () => {
    const workflow = await readFile(join(process.cwd(), ".github", "workflows", "backup.yml"), "utf8");
    const exportDatabase = await readFile(join(process.cwd(), "scripts", "backup", "export-db.sh"), "utf8");
    const restore = await readFile(join(process.cwd(), "scripts", "restore", "restore-from-zero.sh"), "utf8");
    const emptyTargetGuard = await readFile(join(process.cwd(), "scripts", "restore", "assert-empty-target.sql"), "utf8");

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/^\s*schedule:/m);
    expect(workflow).toContain('verify-manifest.mjs "${BACKUP_ROOT}/${BACKUP_RUN_ID}" --for-offsite');
    const encryptIndex = workflow.indexOf('bash -c "${BACKUP_ENCRYPT_COMMAND}" -- "${BACKUP_ROOT}/${BACKUP_RUN_ID}" "${BACKUP_RUN_ID}"');
    const plaintextRemovalIndex = workflow.indexOf('test ! -e "${BACKUP_ROOT}/${BACKUP_RUN_ID}/auth-data.sql"');
    const rebuiltManifestIndex = workflow.indexOf('create-manifest.mjs "${BACKUP_ROOT}/${BACKUP_RUN_ID}"', encryptIndex);
    const offsiteVerifyIndex = workflow.indexOf('verify-manifest.mjs "${BACKUP_ROOT}/${BACKUP_RUN_ID}" --for-offsite');
    const offsiteIndex = workflow.indexOf('bash -c "${BACKUP_OFFSITE_COMMAND}" -- "${BACKUP_ROOT}/${BACKUP_RUN_ID}" "${BACKUP_RUN_ID}"');
    expect(encryptIndex).toBeGreaterThanOrEqual(0);
    expect(plaintextRemovalIndex).toBeGreaterThan(encryptIndex);
    expect(rebuiltManifestIndex).toBeGreaterThan(plaintextRemovalIndex);
    expect(offsiteVerifyIndex).toBeGreaterThan(rebuiltManifestIndex);
    expect(offsiteIndex).toBeGreaterThan(offsiteVerifyIndex);
    expect(workflow).not.toContain("BACKUP_ENCRYPT_COMMAND} '${BACKUP_ROOT}/${BACKUP_RUN_ID}'");
    expect(workflow).not.toContain("BACKUP_OFFSITE_COMMAND} '${BACKUP_ROOT}/${BACKUP_RUN_ID}'");

    expect(exportDatabase).toContain("'application_counts',json_build_object(");
    for (const table of ["app_accounts", "employees", "inventory_balances", "inventory_ledger_entries", "operation_commands", "document_artifacts", "erp_export_artifacts", "import_batches"]) {
      expect(exportDatabase).toContain(`'${table}',(select count(*) from public.${table})`);
    }

    const confirmationIndex = restore.indexOf('[[ "${CONFIRM_RESTORE}" == "YES" ]]');
    const nodeDependencyIndex = restore.indexOf("command -v node");
    const pgRestoreDependencyIndex = restore.indexOf("command -v pg_restore");
    const psqlDependencyIndex = restore.indexOf("command -v psql");
    const ciphertextVerifyIndex = restore.indexOf('verify-manifest.mjs "${BACKUP_RUN_DIR}" --for-offsite');
    const emptyTargetIndex = restore.indexOf("scripts/restore/assert-empty-target.sql");
    const decryptIndex = restore.indexOf('bash -c "${BACKUP_DECRYPT_COMMAND}" -- "${BACKUP_RUN_DIR}"');
    const decryptedVerifyIndex = restore.indexOf('verify-manifest.mjs "${BACKUP_RUN_DIR}"', ciphertextVerifyIndex + 1);
    const metadataValidateIndex = restore.indexOf('verify-metadata.mjs "${BACKUP_RUN_DIR}" --validate-only');
    const pgRestoreIndex = restore.indexOf("pg_restore --no-owner");
    const restoreInvariantIndex = restore.indexOf("scripts/restore/verify.sql");
    const metadataVerifyIndex = restore.indexOf('verify-metadata.mjs "${BACKUP_RUN_DIR}"', metadataValidateIndex + 1);
    const verifiedOutputIndex = restore.indexOf("restore_verified=");
    expect(confirmationIndex).toBeGreaterThanOrEqual(0);
    expect(nodeDependencyIndex).toBeGreaterThan(confirmationIndex);
    expect(pgRestoreDependencyIndex).toBeGreaterThan(confirmationIndex);
    expect(psqlDependencyIndex).toBeGreaterThan(confirmationIndex);
    expect(nodeDependencyIndex).toBeLessThan(ciphertextVerifyIndex);
    expect(pgRestoreDependencyIndex).toBeLessThan(ciphertextVerifyIndex);
    expect(psqlDependencyIndex).toBeLessThan(ciphertextVerifyIndex);
    expect(confirmationIndex).toBeLessThan(ciphertextVerifyIndex);
    expect(ciphertextVerifyIndex).toBeLessThan(decryptIndex);
    expect(emptyTargetIndex).toBeGreaterThan(ciphertextVerifyIndex);
    expect(emptyTargetIndex).toBeLessThan(decryptIndex);
    expect(decryptIndex).toBeLessThan(decryptedVerifyIndex);
    expect(metadataValidateIndex).toBeGreaterThan(decryptedVerifyIndex);
    expect(metadataValidateIndex).toBeLessThan(pgRestoreIndex);
    expect(decryptedVerifyIndex).toBeLessThan(pgRestoreIndex);
    expect(restoreInvariantIndex).toBeGreaterThan(pgRestoreIndex);
    expect(metadataVerifyIndex).toBeGreaterThan(restoreInvariantIndex);
    expect(verifiedOutputIndex).toBeGreaterThan(metadataVerifyIndex);
    expect(restore).not.toContain("BACKUP_DECRYPT_COMMAND} '${BACKUP_RUN_DIR}'");

    expect(emptyTargetGuard).toContain("to_regclass('auth.users') is null");
    expect(emptyTargetGuard).toContain("exists (select 1 from auth.users limit 1)");
    expect(emptyTargetGuard).toContain("n.nspname in ('public', 'private')");
    expect(emptyTargetGuard).toContain("d.deptype = 'e'");
    expect(emptyTargetGuard).toContain("restore target application namespaces are not empty");
  });

  it("validates backup metadata and rejects Auth or application count drift", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uniform-restore-metadata-"));
    try {
      await writeFile(join(directory, "database-metadata.json"), JSON.stringify({
        database_size_bytes: 123456,
        migration_head: "202608290001",
        application_counts: {
          app_accounts: 10,
          employees: 200,
          inventory_balances: 1200,
          inventory_ledger_entries: 8000,
          operation_commands: 400,
          document_artifacts: 90,
          erp_export_artifacts: 22,
          import_batches: 35,
        },
      }), "utf8");
      await writeFile(join(directory, "auth-metadata.json"), JSON.stringify({
        users: 12,
        identities: 12,
        mfa_factors: 3,
      }), "utf8");

      const validation = await execFileAsync(process.execPath, [verifyRestoreMetadataScript, directory, "--validate-only"]);
      expect(validation.stdout).toContain("validated_restore_metadata=");

      const observedPath = join(directory, "observed.json");
      await writeFile(observedPath, JSON.stringify({
        users: 12,
        identities: 12,
        mfa_factors: 3,
        application_counts: {
          app_accounts: 10,
          employees: 200,
          inventory_balances: 1200,
          inventory_ledger_entries: 8000,
          operation_commands: 400,
          document_artifacts: 90,
          erp_export_artifacts: 22,
          import_batches: 35,
        },
      }), "utf8");
      const verified = await execFileAsync(process.execPath, [verifyRestoreMetadataScript, directory, "--observed-json", observedPath]);
      expect(verified.stdout).toContain("verified_restore_metadata=users:12,identities:12,mfa_factors:3,application_counts:verified");

      await writeFile(observedPath, JSON.stringify({
        users: 11,
        identities: 12,
        mfa_factors: 3,
        application_counts: {
          app_accounts: 10,
          employees: 200,
          inventory_balances: 1200,
          inventory_ledger_entries: 8000,
          operation_commands: 400,
          document_artifacts: 90,
          erp_export_artifacts: 22,
          import_batches: 35,
        },
      }), "utf8");
      await expect(
        execFileAsync(process.execPath, [verifyRestoreMetadataScript, directory, "--observed-json", observedPath]),
      ).rejects.toThrow(/Restore metadata mismatch for users/);

      await writeFile(observedPath, JSON.stringify({
        users: 12,
        identities: 12,
        mfa_factors: 3,
        application_counts: {
          app_accounts: 10,
          employees: 199,
          inventory_balances: 1200,
          inventory_ledger_entries: 8000,
          operation_commands: 400,
          document_artifacts: 90,
          erp_export_artifacts: 22,
          import_batches: 35,
        },
      }), "utf8");
      await expect(
        execFileAsync(process.execPath, [verifyRestoreMetadataScript, directory, "--observed-json", observedPath]),
      ).rejects.toThrow(/Restore metadata mismatch for application_counts.employees/);

      await writeFile(join(directory, "database-metadata.json"), JSON.stringify({
        database_size_bytes: 123456,
        migration_head: "202608290001",
      }), "utf8");
      await writeFile(observedPath, JSON.stringify({
        users: 12,
        identities: 12,
        mfa_factors: 3,
      }), "utf8");
      const legacyVerified = await execFileAsync(process.execPath, [verifyRestoreMetadataScript, directory, "--observed-json", observedPath]);
      expect(legacyVerified.stdout).toContain("application_counts:legacy-unavailable");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when restore metadata is malformed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "uniform-restore-metadata-"));
    try {
      await writeFile(join(directory, "database-metadata.json"), JSON.stringify({
        database_size_bytes: 123456,
        migration_head: "202608290001",
      }), "utf8");
      await writeFile(join(directory, "auth-metadata.json"), JSON.stringify({
        users: -1,
        identities: 0,
        mfa_factors: 0,
      }), "utf8");

      await expect(
        execFileAsync(process.execPath, [verifyRestoreMetadataScript, directory, "--validate-only"]),
      ).rejects.toThrow(/auth-metadata.json users must be a non-negative safe integer/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
