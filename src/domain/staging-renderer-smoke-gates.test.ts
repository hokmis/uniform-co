import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const smokeScript = join(process.cwd(), "scripts", "deployment", "staging-renderer-smoke.mjs");

const protectedNames = [
  "UNIFORM_DEPLOYMENT_ENV",
  "UNIFORM_STAGING_SMOKE_CONFIRM",
  "UNIFORM_STAGING_ACTIVE_SMOKE_CONFIRM",
  "UNIFORM_STAGING_RENDERER_SMOKE_CONFIRM",
  "STAGING_DATABASE_URL",
  "DOCUMENT_RENDERER_DATABASE_URL",
  "ERP_RENDERER_DATABASE_URL",
  "RENDER_STORAGE_PROXY_DATABASE_URL",
  "SUPABASE_URL",
  "SUPABASE_STORAGE_ADMIN_KEY",
] as const;

function sanitizedEnvironment() {
  const env = { ...process.env };
  for (const name of protectedNames) delete env[name];
  return env;
}

describe("staging renderer smoke safety gates", () => {
  it("fails closed on the first missing confirmation gate", async () => {
    await expect(
      execFileAsync(process.execPath, [smokeScript], {
        env: sanitizedEnvironment(),
      }),
    ).rejects.toThrow(/UNIFORM_DEPLOYMENT_ENV must equal staging/);
  });

  it("requires protected configuration after every confirmation gate passes", async () => {
    await expect(
      execFileAsync(process.execPath, [smokeScript], {
        env: {
          ...sanitizedEnvironment(),
          UNIFORM_DEPLOYMENT_ENV: "staging",
          UNIFORM_STAGING_SMOKE_CONFIRM: "YES",
          UNIFORM_STAGING_ACTIVE_SMOKE_CONFIRM: "DISPOSABLE_STAGING_ONLY",
          UNIFORM_STAGING_RENDERER_SMOKE_CONFIRM: "RENDERER_STORAGE_WRITE_OK",
        },
      }),
    ).rejects.toThrow(/STAGING_DATABASE_URL is required/);
  });
});
