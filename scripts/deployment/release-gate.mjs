#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA_VERSION = 1;
const EVIDENCE_KINDS = new Set(["TEMPLATE", "RELEASE_EVIDENCE"]);
const PENDING_SOURCE = "PENDING";

export const GATES = Object.freeze([
  {
    id: "repositoryDeploymentSmoke",
    label: "Repository ownership and deployment path smoke",
    allowedSources: ["DEPLOYMENT_SMOKE"],
  },
  {
    id: "stagingMigrationReadOnlySmoke",
    label: "Staging migration and read-only smoke",
    allowedSources: ["STAGING_SMOKE"],
  },
  { id: "rlsSixRole", label: "Six-role RLS acceptance", allowedSources: ["STAGING_SMOKE"] },
  {
    id: "storagePrivateSignedUrlAcl",
    label: "Private Storage, signed URL, and ACL acceptance",
    allowedSources: ["STAGING_SMOKE"],
  },
  {
    id: "durableImportWorkerConcurrency",
    label: "Durable import, worker, and concurrency smoke",
    allowedSources: ["STAGING_SMOKE"],
  },
  {
    id: "rendererPdfErp",
    label: "Renderer, PDF, and ERP smoke",
    allowedSources: ["STAGING_SMOKE"],
  },
  {
    id: "storageDestructiveCleanup",
    label: "Destructive Storage cleanup staging smoke",
    allowedSources: ["STAGING_SMOKE"],
  },
  {
    id: "databaseRetention",
    label: "Database 90-day retention, race, and payload scrub smoke",
    allowedSources: ["STAGING_SMOKE"],
  },
  {
    id: "backupFromZeroRestore",
    label: "Backup from-zero restore drill",
    allowedSources: ["RESTORE_DRILL"],
  },
  { id: "rpoRtoAcceptance", label: "RPO/RTO acceptance", allowedSources: ["BUSINESS_ACCEPTANCE"] },
  {
    id: "capacityValidated",
    label: "Three-year capacity gate validated",
    allowedSources: ["CAPACITY_VALIDATION"],
  },
  {
    id: "externalErrorMonitoring",
    label: "External error monitoring and alert routing smoke",
    allowedSources: ["PROVIDER_SMOKE"],
  },
  { id: "erpImportAcceptance", label: "鼎新 successful import acceptance", allowedSources: ["ERP_ACCEPTANCE"] },
  { id: "formalPdfApproval", label: "Formal PDF style approval", allowedSources: ["BUSINESS_ACCEPTANCE"] },
  {
    id: "firstProductionAccounts",
    label: "First production accounts, roles, and scope acceptance",
    allowedSources: ["ACCESS_ACCEPTANCE"],
  },
  {
    id: "ownerBackupOwnerHandoff",
    label: "Primary and backup owner handoff",
    allowedSources: ["OPERATIONS_ACCEPTANCE"],
  },
  {
    id: "productionCutoverApproval",
    label: "Production cutover approval",
    allowedSources: ["PRODUCTION_APPROVAL"],
  },
]);

function fail(message) {
  const error = new Error(message);
  error.name = "ReleaseGateValidationError";
  throw error;
}

function objectAt(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${path} must be an object`);
  return value;
}

function booleanAt(value, path) {
  if (typeof value !== "boolean") fail(`${path} must be a boolean`);
  return value;
}

function stringAt(value, path, { allowEmpty = false } = {}) {
  if (typeof value !== "string") fail(`${path} must be a string`);
  const normalized = value.trim();
  if (!allowEmpty && normalized.length === 0) fail(`${path} must not be empty`);
  return normalized;
}

export function validateSafeReference(value, path) {
  if (value.length === 0) return value;
  if (value.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)) {
    fail(`${path} must be an opaque evidence path/id without query strings, credentials, or whitespace`);
  }
  return value;
}

export function validateReleaseId(value) {
  if (value.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) {
    fail("releaseId must be a non-secret release identifier using letters, numbers, dot, underscore, slash, or hyphen");
  }
  return value;
}

function validateGate(raw, definition, evidenceKind) {
  const gate = objectAt(raw, `gates.${definition.id}`);
  const passed = booleanAt(gate.passed, `gates.${definition.id}.passed`);
  const source = stringAt(gate.source, `gates.${definition.id}.source`);
  const evidenceReference = validateSafeReference(
    stringAt(gate.evidenceReference, `gates.${definition.id}.evidenceReference`, { allowEmpty: true }),
    `gates.${definition.id}.evidenceReference`,
  );

  if (evidenceKind === "TEMPLATE") {
    if (passed || source !== "TEMPLATE" || evidenceReference.length > 0) {
      fail(`template gate ${definition.id} must remain passed=false, source=TEMPLATE, with no evidenceReference`);
    }
    return { passed, source, evidenceReference };
  }

  if (source === "TEMPLATE") fail(`release evidence gate ${definition.id} cannot use source=TEMPLATE`);

  const allowedSources = new Set([PENDING_SOURCE, ...definition.allowedSources]);
  if (!allowedSources.has(source)) {
    fail(`gates.${definition.id}.source must be one of: ${[...allowedSources].join(", ")}`);
  }

  if (passed) {
    if (!definition.allowedSources.includes(source)) {
      fail(`passed gate ${definition.id} must use an approved evidence source`);
    }
    if (evidenceReference.length === 0) fail(`passed gate ${definition.id} requires evidenceReference`);
  } else if (source !== PENDING_SOURCE && evidenceReference.length === 0) {
    fail(`failed gate ${definition.id} using ${source} requires evidenceReference`);
  }

  return { passed, source, evidenceReference };
}

export function validateInput(raw) {
  const root = objectAt(raw, "input");
  if (root.schemaVersion !== SCHEMA_VERSION) fail(`schemaVersion must be ${SCHEMA_VERSION}`);

  const evidenceKind = stringAt(root.evidenceKind, "evidenceKind");
  if (!EVIDENCE_KINDS.has(evidenceKind)) {
    fail(`evidenceKind must be one of: ${[...EVIDENCE_KINDS].join(", ")}`);
  }

  const releaseId = stringAt(root.releaseId, "releaseId", { allowEmpty: evidenceKind === "TEMPLATE" });
  if (evidenceKind === "TEMPLATE" && releaseId.length > 0) fail("template releaseId must remain empty");
  if (evidenceKind === "RELEASE_EVIDENCE") validateReleaseId(releaseId);

  const gates = objectAt(root.gates, "gates");
  const knownGateIds = new Set(GATES.map((gate) => gate.id));
  for (const gateId of Object.keys(gates)) {
    if (!knownGateIds.has(gateId)) fail(`unknown gate: ${gateId}`);
  }

  const validatedGates = {};
  for (const definition of GATES) {
    if (!(definition.id in gates)) fail(`required gate is missing: ${definition.id}`);
    validatedGates[definition.id] = validateGate(gates[definition.id], definition, evidenceKind);
  }

  return { schemaVersion: SCHEMA_VERSION, evidenceKind, releaseId, gates: validatedGates };
}

export function evaluate(input) {
  const gateResults = GATES.map((definition) => {
    const evidence = input.gates[definition.id];
    return {
      id: definition.id,
      label: definition.label,
      status: evidence.passed ? "PASS" : "BLOCKED",
      source: evidence.source,
      evidenceReference: evidence.evidenceReference,
    };
  });

  const passed = gateResults.filter((gate) => gate.status === "PASS").length;
  const reasons = gateResults.filter((gate) => gate.status !== "PASS").map((gate) => `${gate.id}: not passed`);
  if (input.evidenceKind === "TEMPLATE") reasons.unshift("committed template is not release evidence");

  const ready = input.evidenceKind === "RELEASE_EVIDENCE" && passed === GATES.length;
  return {
    schemaVersion: SCHEMA_VERSION,
    evidenceKind: input.evidenceKind,
    releaseId: input.releaseId,
    status: ready ? "READY" : "NOT_READY",
    summary: { required: GATES.length, passed, blocked: GATES.length - passed },
    gates: gateResults,
    reasons,
  };
}

function printHuman(result) {
  console.log("Uniform Co production release gate");
  console.log(`Release: ${result.releaseId || "<template>"}`);
  console.log(`Status: ${result.status}`);
  console.log(`Gates: ${result.summary.passed}/${result.summary.required} passed`);
  for (const gate of result.gates) {
    console.log(`- ${gate.status} ${gate.id} (${gate.source})`);
  }
  if (result.status !== "READY") console.log("Production cutover remains blocked.");
}

function parseArgs(argv) {
  const args = { inputPath: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--json") {
      args.json = true;
      continue;
    }
    if (value === "--input") {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) fail("--input requires a path");
      args.inputPath = next;
      index += 1;
      continue;
    }
    if (value.startsWith("--input=")) {
      args.inputPath = value.slice("--input=".length);
      continue;
    }
    fail(`unknown argument: ${value}`);
  }
  if (!args.inputPath) fail("--input <path> is required");
  return args;
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const path = resolve(process.cwd(), args.inputPath);
    let parsed;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      fail(`cannot read valid JSON input: ${error instanceof Error ? error.message : "unknown error"}`);
    }

    const result = evaluate(validateInput(parsed));
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else printHuman(result);
    if (result.status !== "READY") process.exitCode = 1;
  } catch (error) {
    console.error(`Release gate rejected: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 2;
  }
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : null;
if (entrypoint === fileURLToPath(import.meta.url)) await main();
