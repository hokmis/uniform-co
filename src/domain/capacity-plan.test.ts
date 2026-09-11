import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const script = join(process.cwd(), "scripts", "capacity", "capacity-plan.mjs");
const template = join(
  process.cwd(),
  "docs",
  "deployment",
  "onboarding",
  "templates",
  "capacity-assumptions.example.json",
);
const tempDirs: string[] = [];

async function baseInput() {
  return JSON.parse(await readFile(template, "utf8")) as Record<string, unknown>;
}

async function writeInput(value: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "uniform-capacity-"));
  tempDirs.push(dir);
  const path = join(dir, "input.json");
  await writeFile(path, JSON.stringify(value, null, 2));
  return path;
}

async function runJson(value: unknown) {
  const path = await writeInput(value);
  const result = await execFileAsync(process.execPath, [script, "--input", path, "--json"]);
  return JSON.parse(result.stdout) as {
    estimate: { databaseBytes: number; storageBytes: number };
    measurement: { gates: { db: { status: string } | null; storage: { status: string } | null } };
    capacityValidation: { status: string; reasons: string[] };
  };
}

function asObject(value: unknown) {
  return value as Record<string, any>;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("three-year capacity planning gate", () => {
  it("fails closed when --input is missing", async () => {
    await expect(execFileAsync(process.execPath, [script, "--json"])).rejects.toMatchObject({ code: 2 });
  });

  it("runs the committed template deterministically but never treats it as measured evidence", async () => {
    const first = await execFileAsync(process.execPath, [script, "--input", template, "--json"]);
    const second = await execFileAsync(process.execPath, [script, "--input", template, "--json"]);
    expect(first.stdout).toBe(second.stdout);
    const parsed = JSON.parse(first.stdout) as { capacityValidation: { status: string }; estimate: { modelOnly: boolean } };
    expect(parsed.capacityValidation.status).toBe("NOT_VALIDATED");
    expect(parsed.estimate.modelOnly).toBe(true);
  });

  it.each([
    [299_999_999, "PASS"],
    [300_000_000, "WARNING"],
    [350_000_000, "DECISION"],
    [425_000_000, "SUSPEND"],
  ])("classifies the DB boundary %s as %s", async (bytes, status) => {
    const input = asObject(await baseInput());
    input.evidence = {
      source: "STAGING_SYNTHETIC",
      evidenceReference: "release/capacity/example",
      syntheticThreeYearDbBytes: bytes,
      syntheticThreeYearStorageBytes: 100_000_000,
      peakPerformancePassed: true,
      restoreDrillPassed: true,
      backupEgressQuotaRatio: 0.4,
      actionsMinutesQuotaRatio: 0.4,
    };
    const result = await runJson(input);
    expect(result.measurement.gates.db?.status).toBe(status);
  });

  it.each([
    [599_999_999, "PASS"],
    [600_000_000, "WARNING"],
    [700_000_000, "DECISION"],
    [850_000_000, "SUSPEND"],
  ])("classifies the Storage boundary %s as %s", async (bytes, status) => {
    const input = asObject(await baseInput());
    input.evidence = {
      source: "STAGING_SYNTHETIC",
      evidenceReference: "release/capacity/example",
      syntheticThreeYearDbBytes: 100_000_000,
      syntheticThreeYearStorageBytes: bytes,
      peakPerformancePassed: true,
      restoreDrillPassed: true,
      backupEgressQuotaRatio: 0.4,
      actionsMinutesQuotaRatio: 0.4,
    };
    const result = await runJson(input);
    expect(result.measurement.gates.storage?.status).toBe(status);
  });

  it("requires real staging evidence and all external acceptance checks before capacity is validated", async () => {
    const input = asObject(await baseInput());
    input.evidence = {
      source: "STAGING_SYNTHETIC",
      evidenceReference: "release/capacity/2026-08-29",
      syntheticThreeYearDbBytes: 250_000_000,
      syntheticThreeYearStorageBytes: 500_000_000,
      peakPerformancePassed: true,
      restoreDrillPassed: true,
      backupEgressQuotaRatio: 0.59,
      actionsMinutesQuotaRatio: 0.59,
    };
    const validated = await runJson(input);
    expect(validated.capacityValidation.status).toBe("VALIDATED");

    input.evidence.actionsMinutesQuotaRatio = 0.6;
    const blocked = await runJson(input);
    expect(blocked.capacityValidation.status).toBe("BLOCKED");
    expect(blocked.capacityValidation.reasons).toContain("30-day GitHub Actions minutes must be below 60% of quota");
  });

  it("rejects template inputs that try to carry measured evidence", async () => {
    const input = asObject(await baseInput());
    input.evidence.syntheticThreeYearDbBytes = 1;
    const path = await writeInput(input);
    await expect(execFileAsync(process.execPath, [script, "--input", path, "--json"])).rejects.toMatchObject({ code: 2 });
  });

  it("rejects missing, negative, non-finite, and unknown schema assumptions", async () => {
    const missing = asObject(await baseInput());
    delete missing.assumptions.imports.maximumRows;
    await expect(execFileAsync(process.execPath, [script, "--input", await writeInput(missing), "--json"])).rejects.toMatchObject({ code: 2 });

    const negative = asObject(await baseInput());
    negative.assumptions.entities.currentEmployees = -1;
    await expect(execFileAsync(process.execPath, [script, "--input", await writeInput(negative), "--json"])).rejects.toMatchObject({ code: 2 });

    const unknown = asObject(await baseInput());
    unknown.schemaVersion = 999;
    await expect(execFileAsync(process.execPath, [script, "--input", await writeInput(unknown), "--json"])).rejects.toMatchObject({ code: 2 });

    const dir = await mkdtemp(join(tmpdir(), "uniform-capacity-"));
    tempDirs.push(dir);
    const infinitePath = join(dir, "infinite.json");
    const templateText = await readFile(template, "utf8");
    await writeFile(infinitePath, templateText.replace('"currentEmployees": 500', '"currentEmployees": 1e999'));
    await expect(execFileAsync(process.execPath, [script, "--input", infinitePath, "--json"])).rejects.toMatchObject({ code: 2 });

    const nanPath = join(dir, "nan.json");
    await writeFile(nanPath, templateText.replace('"currentEmployees": 500', '"currentEmployees": NaN'));
    await expect(execFileAsync(process.execPath, [script, "--input", nanPath, "--json"])).rejects.toMatchObject({ code: 2 });
  });
});
