import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const preflightScript = join(process.cwd(), "scripts", "deployment", "staging-preflight.mjs");
const sentinel = "DO_NOT_PRINT_THIS_SECRET_9f3a";

const preflightNames = [
  "UNIFORM_DEPLOYMENT_ENV",
  "SUPABASE_ACCESS_TOKEN",
  "SUPABASE_PROJECT_REF",
  "SUPABASE_DB_PASSWORD",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SECRET_KEY",
  "IMPORT_WORKER_DATABASE_URL",
  "DATABASE_URL",
  "IMPORT_STORAGE_PROXY_URL",
  "RENDER_STORAGE_PROXY_URL",
  "IMPORT_STORAGE_PROXY_TOKEN",
  "RENDER_STORAGE_PROXY_TOKEN",
  "RENDER_COMMAND",
  "RENDER_COMMAND_ARGS",
  "RENDER_STORAGE_PROXY_DATABASE_URL",
  "SUPABASE_URL",
  "SUPABASE_STORAGE_ADMIN_KEY",
  "RENDER_STORAGE_PROXY_PORT",
  "SUPABASE_DB_URL",
  "BACKUP_ROOT",
  "BACKUP_STORAGE_BUCKETS",
  "BACKUP_ENCRYPT_COMMAND",
  "BACKUP_OFFSITE_COMMAND",
  "BACKUP_RUN_DIR",
  "TARGET_DATABASE_URL",
  "BACKUP_DECRYPT_COMMAND",
  "CLEANUP_DATABASE_URL",
  "CLEANUP_SUPABASE_URL",
  "CLEANUP_STORAGE_ADMIN_KEY",
  "IMPORT_RETENTION_DATABASE_URL",
] as const;

function smokeEnvironment() {
  const env = { ...process.env };
  for (const name of preflightNames) delete env[name];
  for (const name of Object.keys(env)) {
    if (name.startsWith("NEXT_PUBLIC_")) delete env[name];
  }

  return {
    ...env,
    UNIFORM_DEPLOYMENT_ENV: "staging",
    SUPABASE_ACCESS_TOKEN: sentinel,
    SUPABASE_PROJECT_REF: "example-project-ref",
    SUPABASE_DB_PASSWORD: sentinel,
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: sentinel,
    SUPABASE_SERVICE_ROLE_KEY: sentinel,
    IMPORT_WORKER_DATABASE_URL: `postgresql://worker:${sentinel}@localhost:5432/uniform`,
    IMPORT_STORAGE_PROXY_URL: "https://storage-proxy.invalid",
    IMPORT_STORAGE_PROXY_TOKEN: sentinel,
    DATABASE_URL: `postgresql://renderer:${sentinel}@localhost:5432/uniform`,
    RENDER_STORAGE_PROXY_URL: "https://storage-proxy.invalid",
    RENDER_STORAGE_PROXY_TOKEN: sentinel,
    RENDER_COMMAND: process.execPath,
    RENDER_COMMAND_ARGS: '["adapter.mjs"]',
    RENDER_STORAGE_PROXY_DATABASE_URL: `postgresql://proxy:${sentinel}@localhost:5432/uniform`,
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_STORAGE_ADMIN_KEY: sentinel,
    RENDER_STORAGE_PROXY_PORT: "8787",
  };
}

function backupEnvironment() {
  return {
    ...smokeEnvironment(),
    SUPABASE_DB_URL: `postgresql://backup:${sentinel}@localhost:5432/uniform`,
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: sentinel,
    BACKUP_ROOT: "C:/protected/uniform-backups",
    BACKUP_STORAGE_BUCKETS: "uniform-imports,uniform-artifacts,uniform-render-temp,uniform-pdf,uniform-erp",
    BACKUP_ENCRYPT_COMMAND: `encrypt-${sentinel} "$1" "$2"`,
    BACKUP_OFFSITE_COMMAND: `offsite-${sentinel} "$1" "$2"`,
  };
}

function restoreEnvironment() {
  return {
    ...smokeEnvironment(),
    BACKUP_RUN_DIR: "C:/protected/uniform-backups/safe-run",
    TARGET_DATABASE_URL: `postgresql://restore:${sentinel}@localhost:5432/uniform_restore`,
    BACKUP_DECRYPT_COMMAND: `decrypt-${sentinel} "$1"`,
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: sentinel,
  };
}

function cleanupEnvironment() {
  return {
    ...smokeEnvironment(),
    CLEANUP_DATABASE_URL: `postgresql://job_storage_cleanup:${sentinel}@localhost:5432/uniform`,
  };
}

function importRetentionEnvironment() {
  return {
    ...smokeEnvironment(),
    IMPORT_RETENTION_DATABASE_URL: `postgresql://job_import_retention:${sentinel}@localhost:5432/uniform`,
  };
}

describe("staging preflight safety", () => {
  it("validates a complete smoke configuration without printing secret values", async () => {
    const result = await execFileAsync(process.execPath, [preflightScript, "--scope=smoke"], {
      env: smokeEnvironment(),
    });

    expect(result.stdout).toContain("Summary:");
    expect(result.stdout).toContain("0 failed");
    expect(result.stdout).not.toContain(sentinel);
    expect(result.stderr).not.toContain(sentinel);
  });

  it("rejects a privileged NEXT_PUBLIC variable by name without echoing its value", async () => {
    let captured: unknown;
    try {
      await execFileAsync(process.execPath, [preflightScript, "--scope=smoke"], {
        env: {
          ...smokeEnvironment(),
          NEXT_PUBLIC_DATABASE_PASSWORD: sentinel,
        },
      });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeTruthy();
    const failure = captured as { stdout?: string; stderr?: string };
    const output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
    expect(output).toContain("NEXT_PUBLIC_DATABASE_PASSWORD");
    expect(output).not.toContain(sentinel);
  });

  it("validates backup and restore command positional-argument contracts without printing commands", async () => {
    const backup = await execFileAsync(process.execPath, [preflightScript, "--scope=backup"], {
      env: backupEnvironment(),
    });
    const restore = await execFileAsync(process.execPath, [preflightScript, "--scope=restore"], {
      env: restoreEnvironment(),
    });

    expect(backup.stdout).toContain("0 failed");
    expect(backup.stdout).toContain("BACKUP_ENCRYPT_COMMAND uses $1 and $2 positional arguments");
    expect(backup.stdout).toContain("BACKUP_OFFSITE_COMMAND uses $1 and $2 positional arguments");
    expect(restore.stdout).toContain("0 failed");
    expect(restore.stdout).toContain("BACKUP_DECRYPT_COMMAND uses $1 positional arguments");
    expect(`${backup.stdout}${backup.stderr}${restore.stdout}${restore.stderr}`).not.toContain(sentinel);
  });

  it("rejects backup commands missing a positional argument without echoing command content", async () => {
    let captured: unknown;
    try {
      await execFileAsync(process.execPath, [preflightScript, "--scope=backup"], {
        env: {
          ...backupEnvironment(),
          BACKUP_ENCRYPT_COMMAND: `encrypt-${sentinel} "$1"`,
        },
      });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeTruthy();
    const failure = captured as { stdout?: string; stderr?: string };
    const output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
    expect(output).toContain("BACKUP_ENCRYPT_COMMAND uses $1 and $2 positional arguments");
    expect(output).not.toContain(sentinel);
  });

  it("rejects a restore command missing $1 without echoing command content", async () => {
    let captured: unknown;
    try {
      await execFileAsync(process.execPath, [preflightScript, "--scope=restore"], {
        env: {
          ...restoreEnvironment(),
          BACKUP_DECRYPT_COMMAND: `decrypt-${sentinel} --fixed-flag`,
        },
      });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeTruthy();
    const failure = captured as { stdout?: string; stderr?: string };
    const output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
    expect(output).toContain("BACKUP_DECRYPT_COMMAND uses $1 positional arguments");
    expect(output).not.toContain(sentinel);
  });

  it("validates cleanup dry-run credentials and the exact cleanup DB role without requiring Storage admin credentials", async () => {
    const result = await execFileAsync(process.execPath, [preflightScript, "--scope=cleanup"], {
      env: cleanupEnvironment(),
    });

    expect(result.stdout).toContain("0 failed");
    expect(result.stdout).toContain("CLEANUP_DATABASE_URL username is job_storage_cleanup");
    expect(result.stdout).not.toContain(sentinel);
  });

  it("rejects a cleanup connection using another DB role and never prints the URL secret", async () => {
    let captured: unknown;
    try {
      await execFileAsync(process.execPath, [preflightScript, "--scope=cleanup"], {
        env: {
          ...cleanupEnvironment(),
          CLEANUP_DATABASE_URL: `postgresql://postgres:${sentinel}@localhost:5432/uniform`,
        },
      });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeTruthy();
    const failure = captured as { stdout?: string; stderr?: string };
    const output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
    expect(output).toContain("job_storage_cleanup");
    expect(output).not.toContain(sentinel);
  });

  it("requires both execute-side Storage values when either one is configured", async () => {
    let captured: unknown;
    try {
      await execFileAsync(process.execPath, [preflightScript, "--scope=cleanup"], {
        env: {
          ...cleanupEnvironment(),
          CLEANUP_SUPABASE_URL: "https://example.supabase.co",
        },
      });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeTruthy();
    const failure = captured as { stdout?: string; stderr?: string };
    expect(`${failure.stdout ?? ""}${failure.stderr ?? ""}`).toContain("CLEANUP_STORAGE_ADMIN_KEY");
  });

  it("validates import staging retention with only the dedicated DB login", async () => {
    const result = await execFileAsync(process.execPath, [preflightScript, "--scope=import-retention"], {
      env: importRetentionEnvironment(),
    });

    expect(result.stdout).toContain("0 failed");
    expect(result.stdout).toContain("IMPORT_RETENTION_DATABASE_URL username is job_import_retention");
    expect(result.stdout).not.toContain(sentinel);
  });

  it("rejects import retention configured with another database role", async () => {
    let captured: unknown;
    try {
      await execFileAsync(process.execPath, [preflightScript, "--scope=import-retention"], {
        env: {
          ...importRetentionEnvironment(),
          IMPORT_RETENTION_DATABASE_URL: `postgresql://job_storage_cleanup:${sentinel}@localhost:5432/uniform`,
        },
      });
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeTruthy();
    const failure = captured as { stdout?: string; stderr?: string };
    const output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
    expect(output).toContain("job_import_retention");
    expect(output).not.toContain(sentinel);
  });
});
