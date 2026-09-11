import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const evidenceScript = join(process.cwd(), "scripts", "deployment", "release-evidence.mjs");
const gateScript = join(process.cwd(), "scripts", "deployment", "release-gate.mjs");
const templatePath = join(
  process.cwd(),
  "docs",
  "deployment",
  "onboarding",
  "templates",
  "release-evidence.example.json",
);
const tempDirs: string[] = [];

async function tempPath(name = "release-evidence.json") {
  const dir = await mkdtemp(join(tmpdir(), "uniform-release-evidence-"));
  tempDirs.push(dir);
  return join(dir, name);
}

async function run(args: string[]) {
  try {
    const result = await execFileAsync(process.execPath, [evidenceScript, ...args]);
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

async function gate(path: string) {
  try {
    const result = await execFileAsync(process.execPath, [gateScript, "--input", path, "--json"]);
    return { code: 0, stdout: result.stdout };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string };
    return { code: failure.code ?? -1, stdout: failure.stdout ?? "" };
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("release evidence helper", () => {
  it("initializes formal evidence with every gate pending and refuses overwrite", async () => {
    const path = await tempPath();
    const first = await run(["init", "--release-id", "release/2026-08-29", "--output", path]);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("Status: NOT_READY (0/17 gates passed)");

    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      evidenceKind: string;
      gates: Record<string, { passed: boolean; source: string; evidenceReference: string }>;
    };
    expect(parsed.evidenceKind).toBe("RELEASE_EVIDENCE");
    expect(Object.values(parsed.gates)).toHaveLength(17);
    expect(Object.values(parsed.gates).every((item) => !item.passed && item.source === "PENDING" && item.evidenceReference === "")).toBe(true);

    const evaluated = await gate(path);
    expect(evaluated.code).toBe(1);
    expect(JSON.parse(evaluated.stdout)).toMatchObject({ status: "NOT_READY", summary: { passed: 0, blocked: 17 } });

    const second = await run(["init", "--release-id", "release/other", "--output", path]);
    expect(second.code).toBe(2);
    expect(second.stderr).toContain("refusing to overwrite existing release evidence");
  });

  it("records only an approved gate/source/reference combination", async () => {
    const path = await tempPath();
    expect((await run(["init", "--release-id", "release/2026-08-29", "--output", path])).code).toBe(0);

    const result = await run([
      "record",
      "--input",
      path,
      "--gate",
      "rlsSixRole",
      "--source",
      "STAGING_SMOKE",
      "--evidence-reference",
      "evidence/staging/rls-six-role-20260829",
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Status: NOT_READY (1/17 gates passed)");
    expect(result.stdout).not.toContain("evidence/staging/rls-six-role-20260829");

    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      gates: Record<string, { passed: boolean; source: string; evidenceReference: string }>;
    };
    expect(parsed.gates.rlsSixRole).toEqual({
      passed: true,
      source: "STAGING_SMOKE",
      evidenceReference: "evidence/staging/rls-six-role-20260829",
    });
    expect((await readdir(join(path, ".."))).some((name) => name.includes(".tmp-"))).toBe(false);
  });

  it("can fail closed by blocking a previously recorded gate", async () => {
    const path = await tempPath();
    expect((await run(["init", "--release-id", "release/2026-08-29", "--output", path])).code).toBe(0);
    expect(
      (
        await run([
          "record",
          "--input",
          path,
          "--gate",
          "rlsSixRole",
          "--source",
          "STAGING_SMOKE",
          "--evidence-reference",
          "evidence/staging/rls-six-role-20260829",
        ])
      ).code,
    ).toBe(0);

    const result = await run(["block", "--input", path, "--gate", "rlsSixRole"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Status: NOT_READY (0/17 gates passed)");

    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      gates: Record<string, { passed: boolean; source: string; evidenceReference: string }>;
    };
    expect(parsed.gates.rlsSixRole).toEqual({ passed: false, source: "PENDING", evidenceReference: "" });
    expect((await readdir(join(path, ".."))).some((name) => name.includes(".tmp-"))).toBe(false);
  });

  it("fails closed while another evidence update lock exists and never steals that lock", async () => {
    const path = await tempPath();
    expect((await run(["init", "--release-id", "release/2026-08-29", "--output", path])).code).toBe(0);
    const before = await readFile(path, "utf8");
    const lockPath = `${path}.lock`;
    await writeFile(lockPath, "held-by-other-updater\n", { encoding: "utf8", flag: "wx" });

    const blockedByLock = await run([
      "record",
      "--input",
      path,
      "--gate",
      "rlsSixRole",
      "--source",
      "STAGING_SMOKE",
      "--evidence-reference",
      "evidence/staging/rls-six-role-20260829",
    ]);
    expect(blockedByLock.code).toBe(2);
    expect(blockedByLock.stderr).toContain("another release evidence update is in progress");
    expect(await readFile(path, "utf8")).toBe(before);
    expect(await readFile(lockPath, "utf8")).toBe("held-by-other-updater\n");

    await rm(lockPath);
    const retry = await run([
      "record",
      "--input",
      path,
      "--gate",
      "rlsSixRole",
      "--source",
      "STAGING_SMOKE",
      "--evidence-reference",
      "evidence/staging/rls-six-role-20260829",
    ]);
    expect(retry.code).toBe(0);
    expect((await readdir(join(path, ".."))).some((name) => name.endsWith(".lock") || name.includes(".tmp-"))).toBe(false);
  });

  it("rejects unknown gates, unapproved sources, and unsafe references without changing the file", async () => {
    const path = await tempPath();
    expect((await run(["init", "--release-id", "release/2026-08-29", "--output", path])).code).toBe(0);
    const before = await readFile(path, "utf8");

    expect(
      (await run(["record", "--input", path, "--gate", "notAGate", "--source", "STAGING_SMOKE", "--evidence-reference", "evidence/id"])).code,
    ).toBe(2);
    expect(
      (await run(["record", "--input", path, "--gate", "capacityValidated", "--source", "STAGING_SMOKE", "--evidence-reference", "evidence/id"])).code,
    ).toBe(2);
    expect(
      (
        await run([
          "record",
          "--input",
          path,
          "--gate",
          "rlsSixRole",
          "--source",
          "STAGING_SMOKE",
          "--evidence-reference",
          "https://example.invalid/evidence?id=secret",
        ])
      ).code,
    ).toBe(2);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("never converts or edits the committed TEMPLATE in place", async () => {
    const path = await tempPath("template.json");
    await writeFile(path, await readFile(templatePath, "utf8"), "utf8");
    const before = await readFile(path, "utf8");
    const result = await run([
      "record",
      "--input",
      path,
      "--gate",
      "repositoryDeploymentSmoke",
      "--source",
      "DEPLOYMENT_SMOKE",
      "--evidence-reference",
      "evidence/deployment/smoke-1",
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("never edit the template in place");
    expect(await readFile(path, "utf8")).toBe(before);

    const blocked = await run(["block", "--input", path, "--gate", "repositoryDeploymentSmoke"]);
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toContain("never edit the template in place");
    expect(await readFile(path, "utf8")).toBe(before);
  });
});
