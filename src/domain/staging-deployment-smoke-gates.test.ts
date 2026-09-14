import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const readOnlySmokeScript = join(process.cwd(), "scripts", "deployment", "staging-smoke.mjs");
const activeSmokeScript = join(process.cwd(), "scripts", "deployment", "staging-active-smoke.mjs");

const protectedNames = [
  "UNIFORM_DEPLOYMENT_ENV",
  "UNIFORM_STAGING_SMOKE_CONFIRM",
  "UNIFORM_STAGING_ACTIVE_SMOKE_CONFIRM",
  "UNIFORM_STAGING_CUTOVER_SMOKE_CONFIRM",
  "STAGING_DATABASE_URL",
  "IMPORT_WORKER_DATABASE_URL",
] as const;

function sanitizedEnvironment() {
  const env = { ...process.env };
  for (const name of protectedNames) delete env[name];
  return env;
}

describe("staging deployment smoke safety gates", () => {
  it("keeps the read-only smoke closed outside staging", async () => {
    await expect(
      execFileAsync(process.execPath, [readOnlySmokeScript], {
        env: sanitizedEnvironment(),
      }),
    ).rejects.toThrow(/UNIFORM_DEPLOYMENT_ENV must equal staging/);
  });

  it("requires the read-only smoke confirmation before database configuration", async () => {
    await expect(
      execFileAsync(process.execPath, [readOnlySmokeScript], {
        env: {
          ...sanitizedEnvironment(),
          UNIFORM_DEPLOYMENT_ENV: "staging",
        },
      }),
    ).rejects.toThrow(/UNIFORM_STAGING_SMOKE_CONFIRM must equal YES/);
  });

  it("rejects an unknown active-smoke scope before any protected configuration", async () => {
    await expect(
      execFileAsync(process.execPath, [activeSmokeScript, "--scope=unknown"], {
        env: sanitizedEnvironment(),
      }),
    ).rejects.toThrow(/Unknown scope: unknown/);
  });

  it("requires the disposable-staging confirmation before active configuration", async () => {
    await expect(
      execFileAsync(process.execPath, [activeSmokeScript, "--scope=import"], {
        env: {
          ...sanitizedEnvironment(),
          UNIFORM_DEPLOYMENT_ENV: "staging",
          UNIFORM_STAGING_SMOKE_CONFIRM: "YES",
        },
      }),
    ).rejects.toThrow(/UNIFORM_STAGING_ACTIVE_SMOKE_CONFIRM must equal DISPOSABLE_STAGING_ONLY/);
  });

  it("adds an explicit once-only confirmation for cutover fixtures", async () => {
    await expect(
      execFileAsync(process.execPath, [activeSmokeScript, "--scope=cutover"], {
        env: {
          ...sanitizedEnvironment(),
          UNIFORM_DEPLOYMENT_ENV: "staging",
          UNIFORM_STAGING_SMOKE_CONFIRM: "YES",
          UNIFORM_STAGING_ACTIVE_SMOKE_CONFIRM: "DISPOSABLE_STAGING_ONLY",
        },
      }),
    ).rejects.toThrow(/UNIFORM_STAGING_CUTOVER_SMOKE_CONFIRM must equal ONCE_ONLY_OPENING_BALANCE/);
  });

  it("requires protected database configuration only after all import gates pass", async () => {
    await expect(
      execFileAsync(process.execPath, [activeSmokeScript, "--scope=import"], {
        env: {
          ...sanitizedEnvironment(),
          UNIFORM_DEPLOYMENT_ENV: "staging",
          UNIFORM_STAGING_SMOKE_CONFIRM: "YES",
          UNIFORM_STAGING_ACTIVE_SMOKE_CONFIRM: "DISPOSABLE_STAGING_ONLY",
        },
      }),
    ).rejects.toThrow(/STAGING_DATABASE_URL is required/);
  });
});
