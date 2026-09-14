#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { evaluate, GATES, validateInput } from "./release-gate.mjs";

const DEFAULT_PATH = "docs/deployment/onboarding/private/release-evidence.json";
const TEMPLATE_PATH = "docs/deployment/onboarding/templates/release-evidence.example.json";

function fail(message) {
  const error = new Error(message);
  error.name = "ReleaseEvidenceError";
  throw error;
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) fail(`${flag} requires a value`);
  return value;
}

function parseArgs(argv) {
  const command = argv[0];
  if (command !== "init" && command !== "record" && command !== "block") {
    fail("command must be init, record, or block");
  }

  const args = {
    command,
    releaseId: null,
    inputPath: DEFAULT_PATH,
    outputPath: DEFAULT_PATH,
    gateId: null,
    source: null,
    evidenceReference: null,
  };

  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--release-id") {
      args.releaseId = requireValue(argv, index, flag);
      index += 1;
      continue;
    }
    if (flag === "--input") {
      args.inputPath = requireValue(argv, index, flag);
      index += 1;
      continue;
    }
    if (flag === "--output") {
      args.outputPath = requireValue(argv, index, flag);
      index += 1;
      continue;
    }
    if (flag === "--gate") {
      args.gateId = requireValue(argv, index, flag);
      index += 1;
      continue;
    }
    if (flag === "--source") {
      args.source = requireValue(argv, index, flag);
      index += 1;
      continue;
    }
    if (flag === "--evidence-reference") {
      args.evidenceReference = requireValue(argv, index, flag);
      index += 1;
      continue;
    }
    fail(`unknown argument: ${flag}`);
  }

  if (command === "init") {
    if (!args.releaseId) fail("init requires --release-id");
    if (args.gateId || args.source || args.evidenceReference || args.inputPath !== DEFAULT_PATH) {
      fail("init only accepts --release-id and optional --output");
    }
  }

  if (command === "record") {
    if (!args.gateId || !args.source || !args.evidenceReference) {
      fail("record requires --gate, --source, and --evidence-reference");
    }
    if (args.releaseId || args.outputPath !== DEFAULT_PATH) {
      fail("record accepts --input but does not accept --release-id or --output");
    }
  }

  if (command === "block") {
    if (!args.gateId) fail("block requires --gate");
    if (args.releaseId || args.source || args.evidenceReference || args.outputPath !== DEFAULT_PATH) {
      fail("block accepts --input and --gate only");
    }
  }

  return args;
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(`${label} must be readable valid JSON: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

async function initEvidence(args) {
  const templatePath = resolve(process.cwd(), TEMPLATE_PATH);
  const template = validateInput(await readJson(templatePath, "release evidence template"));
  if (template.evidenceKind !== "TEMPLATE") fail("committed release evidence template must remain evidenceKind=TEMPLATE");

  const evidence = {
    schemaVersion: template.schemaVersion,
    evidenceKind: "RELEASE_EVIDENCE",
    releaseId: args.releaseId,
    gates: Object.fromEntries(
      GATES.map((gate) => [gate.id, { passed: false, source: "PENDING", evidenceReference: "" }]),
    ),
  };
  validateInput(evidence);

  const outputPath = resolve(process.cwd(), args.outputPath);
  await mkdir(dirname(outputPath), { recursive: true });
  try {
    await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      fail(`refusing to overwrite existing release evidence: ${args.outputPath}`);
    }
    throw error;
  }

  console.log(`Initialized release evidence: ${args.outputPath}`);
  console.log(`Release: ${evidence.releaseId}`);
  console.log(`Status: NOT_READY (0/${GATES.length} gates passed)`);
}

async function atomicWriteJson(path, value) {
  const tempPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(tempPath, path);
  } finally {
    await rm(tempPath, { force: true });
  }
}

async function withEvidenceUpdateLock(inputPath, update) {
  const lockPath = `${inputPath}.lock`;
  let lockHandle;
  try {
    try {
      lockHandle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
        fail(
          "another release evidence update is in progress; if no update is running, inspect the stale .lock file before removing it",
        );
      }
      throw error;
    }

    return await update();
  } finally {
    if (lockHandle) {
      try {
        await lockHandle.close();
      } finally {
        await rm(lockPath, { force: true });
      }
    }
  }
}

function findGateDefinition(gateId) {
  const definition = GATES.find((gate) => gate.id === gateId);
  if (!definition) fail(`unknown gate: ${gateId}`);
  return definition;
}

async function readFormalEvidence(inputPath) {
  const current = validateInput(await readJson(inputPath, "release evidence"));
  if (current.evidenceKind !== "RELEASE_EVIDENCE") {
    fail("release evidence update requires evidenceKind=RELEASE_EVIDENCE; never edit the template in place");
  }
  return current;
}

async function recordEvidence(args) {
  const inputPath = resolve(process.cwd(), args.inputPath);
  const definition = findGateDefinition(args.gateId);
  if (!definition.allowedSources.includes(args.source)) {
    fail(`source is not approved for gate ${args.gateId}; allowed: ${definition.allowedSources.join(", ")}`);
  }

  await withEvidenceUpdateLock(inputPath, async () => {
    const current = await readFormalEvidence(inputPath);
    const updated = structuredClone(current);
    updated.gates[args.gateId] = {
      passed: true,
      source: args.source,
      evidenceReference: args.evidenceReference,
    };
    const validated = validateInput(updated);
    const result = evaluate(validated);

    await atomicWriteJson(inputPath, updated);
    console.log(`Recorded gate: ${args.gateId}`);
    console.log(`Release: ${result.releaseId}`);
    console.log(`Status: ${result.status} (${result.summary.passed}/${result.summary.required} gates passed)`);
  });
}

async function blockEvidence(args) {
  const inputPath = resolve(process.cwd(), args.inputPath);
  findGateDefinition(args.gateId);

  await withEvidenceUpdateLock(inputPath, async () => {
    const current = await readFormalEvidence(inputPath);
    const updated = structuredClone(current);
    updated.gates[args.gateId] = {
      passed: false,
      source: "PENDING",
      evidenceReference: "",
    };
    const validated = validateInput(updated);
    const result = evaluate(validated);

    await atomicWriteJson(inputPath, updated);
    console.log(`Blocked gate: ${args.gateId}`);
    console.log(`Release: ${result.releaseId}`);
    console.log(`Status: ${result.status} (${result.summary.passed}/${result.summary.required} gates passed)`);
  });
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.command === "init") await initEvidence(args);
    else if (args.command === "record") await recordEvidence(args);
    else await blockEvidence(args);
  } catch (error) {
    console.error(`Release evidence rejected: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 2;
  }
}

await main();
