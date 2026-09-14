import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const script = join(process.cwd(), "scripts", "deployment", "release-gate.mjs");
const template = join(
  process.cwd(),
  "docs",
  "deployment",
  "onboarding",
  "templates",
  "release-evidence.example.json",
);
const tempDirs: string[] = [];

type GateEvidence = { passed: boolean; source: string; evidenceReference: string };
type ReleaseEvidence = {
  schemaVersion: number;
  evidenceKind: string;
  releaseId: string;
  gates: Record<string, GateEvidence>;
};

async function baseInput() {
  return JSON.parse(await readFile(template, "utf8")) as ReleaseEvidence;
}

async function writeInput(value: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "uniform-release-gate-"));
  tempDirs.push(dir);
  const path = join(dir, "input.json");
  await writeFile(path, JSON.stringify(value, null, 2));
  return path;
}

async function run(value: unknown) {
  const path = await writeInput(value);
  try {
    const result = await execFileAsync(process.execPath, [script, "--input", path, "--json"]);
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

function makeReady(input: ReleaseEvidence) {
  input.evidenceKind = "RELEASE_EVIDENCE";
  input.releaseId = "release/2026-08-29";
  const sources: Record<string, string> = {
    repositoryDeploymentSmoke: "DEPLOYMENT_SMOKE",
    stagingMigrationReadOnlySmoke: "STAGING_SMOKE",
    rlsSixRole: "STAGING_SMOKE",
    storagePrivateSignedUrlAcl: "STAGING_SMOKE",
    durableImportWorkerConcurrency: "STAGING_SMOKE",
    rendererPdfErp: "STAGING_SMOKE",
    storageDestructiveCleanup: "STAGING_SMOKE",
    databaseRetention: "STAGING_SMOKE",
    backupFromZeroRestore: "RESTORE_DRILL",
    rpoRtoAcceptance: "BUSINESS_ACCEPTANCE",
    capacityValidated: "CAPACITY_VALIDATION",
    externalErrorMonitoring: "PROVIDER_SMOKE",
    erpImportAcceptance: "ERP_ACCEPTANCE",
    formalPdfApproval: "BUSINESS_ACCEPTANCE",
    firstProductionAccounts: "ACCESS_ACCEPTANCE",
    ownerBackupOwnerHandoff: "OPERATIONS_ACCEPTANCE",
    productionCutoverApproval: "PRODUCTION_APPROVAL",
  };
  for (const [id, gate] of Object.entries(input.gates)) {
    gate.passed = true;
    gate.source = sources[id];
    gate.evidenceReference = `release/evidence/${id}`;
  }
  return input;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("production release gate", () => {
  it("fails closed when --input is missing", async () => {
    await expect(execFileAsync(process.execPath, [script, "--json"])).rejects.toMatchObject({ code: 2 });
  });

  it("keeps the committed template deterministic and permanently NOT_READY", async () => {
    const first = await run(await baseInput());
    const second = await run(await baseInput());
    expect(first.code).toBe(1);
    expect(second.code).toBe(1);
    expect(first.stdout).toBe(second.stdout);
    const parsed = JSON.parse(first.stdout) as { status: string; summary: { passed: number; blocked: number } };
    expect(parsed.status).toBe("NOT_READY");
    expect(parsed.summary.passed).toBe(0);
    expect(parsed.summary.blocked).toBe(17);
  });

  it("rejects a missing required gate and a passed gate without an evidence reference", async () => {
    const missing = makeReady(await baseInput());
    delete missing.gates.rlsSixRole;
    expect((await run(missing)).code).toBe(2);

    const noReference = makeReady(await baseInput());
    noReference.gates.rlsSixRole.evidenceReference = "";
    expect((await run(noReference)).code).toBe(2);
  });

  it("returns NOT_READY when a required gate is still pending", async () => {
    const input = makeReady(await baseInput());
    input.gates.databaseRetention = { passed: false, source: "PENDING", evidenceReference: "" };
    const result = await run(input);
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stdout) as { status: string; reasons: string[] };
    expect(parsed.status).toBe("NOT_READY");
    expect(parsed.reasons).toContain("databaseRetention: not passed");
  });

  it("becomes READY only when every gate has approved real evidence", async () => {
    const result = await run(makeReady(await baseInput()));
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { status: string; summary: { required: number; passed: number } };
    expect(parsed.status).toBe("READY");
    expect(parsed.summary).toEqual({ required: 17, passed: 17, blocked: 0 });
  });

  it("fails closed on unknown schema versions and unapproved evidence sources", async () => {
    const unknown = makeReady(await baseInput());
    unknown.schemaVersion = 999;
    expect((await run(unknown)).code).toBe(2);

    const unapproved = makeReady(await baseInput());
    unapproved.gates.capacityValidated.source = "STAGING_SMOKE";
    expect((await run(unapproved)).code).toBe(2);
  });

  it("rejects a template that tries to impersonate formal release evidence", async () => {
    const input = await baseInput();
    input.evidenceKind = "RELEASE_EVIDENCE";
    input.releaseId = "release/impersonation-test";
    expect((await run(input)).code).toBe(2);
  });

  it("produces deterministic READY output", async () => {
    const input = makeReady(await baseInput());
    const first = await run(input);
    const second = await run(input);
    expect(first.code).toBe(0);
    expect(first.stdout).toBe(second.stdout);
  });
});
