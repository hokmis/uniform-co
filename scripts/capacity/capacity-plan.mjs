#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const SCHEMA_VERSION = 1;
const PROJECTION_YEARS = 3;
const DECIMAL_MB = 1_000_000;
const DECIMAL_GB = 1_000_000_000;

const QUOTAS = Object.freeze({
  database: {
    name: "Supabase database",
    quotaBytes: 500 * DECIMAL_MB,
    warningBytes: 300 * DECIMAL_MB,
    decisionBytes: 350 * DECIMAL_MB,
    suspendBytes: 425 * DECIMAL_MB,
  },
  storage: {
    name: "Supabase Storage",
    quotaBytes: 1 * DECIMAL_GB,
    warningBytes: 600 * DECIMAL_MB,
    decisionBytes: 700 * DECIMAL_MB,
    suspendBytes: 850 * DECIMAL_MB,
  },
});

const EVIDENCE_SOURCES = new Set(["TEMPLATE", "PLANNING", "STAGING_SYNTHETIC"]);

function fail(message) {
  const error = new Error(message);
  error.name = "CapacityPlanValidationError";
  throw error;
}

function objectAt(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${path} must be an object`);
  }
  return value;
}

function numberAt(value, path, { min = 0, allowNull = false, integer = false } = {}) {
  if (allowNull && value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${path} must be a finite number${allowNull ? " or null" : ""}`);
  }
  if (value < min) fail(`${path} must be >= ${min}`);
  if (integer && !Number.isInteger(value)) fail(`${path} must be an integer`);
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

function validateArtifact(value, path) {
  const artifact = objectAt(value, path);
  const annualCount = numberAt(artifact.annualCount, `${path}.annualCount`, { integer: true });
  const averageBytes = numberAt(artifact.averageBytes, `${path}.averageBytes`, { min: 1 });
  const p95Bytes = numberAt(artifact.p95Bytes, `${path}.p95Bytes`, { min: 1 });
  const onlineRetentionMonths = numberAt(artifact.onlineRetentionMonths, `${path}.onlineRetentionMonths`, {
    min: 1,
    integer: true,
  });
  if (p95Bytes < averageBytes) fail(`${path}.p95Bytes must be >= ${path}.averageBytes`);
  return { annualCount, averageBytes, p95Bytes, onlineRetentionMonths };
}

function validateInput(raw) {
  const root = objectAt(raw, "input");
  if (root.schemaVersion !== SCHEMA_VERSION) {
    fail(`schemaVersion must be ${SCHEMA_VERSION}`);
  }
  if (root.projectionYears !== PROJECTION_YEARS) {
    fail(`projectionYears must be ${PROJECTION_YEARS}`);
  }

  const evidence = objectAt(root.evidence, "evidence");
  const source = stringAt(evidence.source, "evidence.source");
  if (!EVIDENCE_SOURCES.has(source)) {
    fail(`evidence.source must be one of: ${[...EVIDENCE_SOURCES].join(", ")}`);
  }
  const evidenceReference = stringAt(evidence.evidenceReference, "evidence.evidenceReference", { allowEmpty: true });
  const syntheticThreeYearDbBytes = numberAt(
    evidence.syntheticThreeYearDbBytes,
    "evidence.syntheticThreeYearDbBytes",
    { allowNull: true },
  );
  const syntheticThreeYearStorageBytes = numberAt(
    evidence.syntheticThreeYearStorageBytes,
    "evidence.syntheticThreeYearStorageBytes",
    { allowNull: true },
  );
  const peakPerformancePassed = booleanAt(evidence.peakPerformancePassed, "evidence.peakPerformancePassed");
  const restoreDrillPassed = booleanAt(evidence.restoreDrillPassed, "evidence.restoreDrillPassed");
  const backupEgressQuotaRatio = numberAt(evidence.backupEgressQuotaRatio, "evidence.backupEgressQuotaRatio", {
    allowNull: true,
  });
  const actionsMinutesQuotaRatio = numberAt(evidence.actionsMinutesQuotaRatio, "evidence.actionsMinutesQuotaRatio", {
    allowNull: true,
  });

  if (source !== "STAGING_SYNTHETIC") {
    const carriesMeasuredEvidence = [
      syntheticThreeYearDbBytes,
      syntheticThreeYearStorageBytes,
      backupEgressQuotaRatio,
      actionsMinutesQuotaRatio,
    ].some((value) => value !== null) || peakPerformancePassed || restoreDrillPassed || evidenceReference.length > 0;
    if (carriesMeasuredEvidence) {
      fail("only evidence.source=STAGING_SYNTHETIC may carry measured validation evidence");
    }
  }

  const assumptions = objectAt(root.assumptions, "assumptions");
  const entities = objectAt(assumptions.entities, "assumptions.entities");
  const validatedEntities = {
    currentEmployees: numberAt(entities.currentEmployees, "assumptions.entities.currentEmployees", { integer: true }),
    year3Employees: numberAt(entities.year3Employees, "assumptions.entities.year3Employees", { integer: true }),
    institutions: numberAt(entities.institutions, "assumptions.entities.institutions", { integer: true }),
    departments: numberAt(entities.departments, "assumptions.entities.departments", { integer: true }),
    uniformItems: numberAt(entities.uniformItems, "assumptions.entities.uniformItems", { integer: true }),
  };

  const annualTransactions = objectAt(assumptions.annualTransactions, "assumptions.annualTransactions");
  const validatedAnnualTransactions = {};
  for (const key of ["issues", "restocks", "stocktakes", "corrections", "returns", "seasonalDemand", "purchases", "receipts"]) {
    validatedAnnualTransactions[key] = numberAt(
      annualTransactions[key],
      `assumptions.annualTransactions.${key}`,
      { integer: true },
    );
  }

  const imports = objectAt(assumptions.imports, "assumptions.imports");
  const validatedImports = {
    perMonth: numberAt(imports.perMonth, "assumptions.imports.perMonth", { integer: true }),
    averageRows: numberAt(imports.averageRows, "assumptions.imports.averageRows", { integer: true }),
    maximumRows: numberAt(imports.maximumRows, "assumptions.imports.maximumRows", { integer: true }),
    averageRawJsonBytes: numberAt(imports.averageRawJsonBytes, "assumptions.imports.averageRawJsonBytes", { min: 1 }),
  };
  if (validatedImports.maximumRows < validatedImports.averageRows) {
    fail("assumptions.imports.maximumRows must be >= assumptions.imports.averageRows");
  }

  const auditAmplification = numberAt(assumptions.auditAmplification, "assumptions.auditAmplification");
  const database = objectAt(assumptions.database, "assumptions.database");
  const validatedDatabase = {
    masterRowAverageBytes: numberAt(database.masterRowAverageBytes, "assumptions.database.masterRowAverageBytes", { min: 1 }),
    transactionRowAverageBytes: numberAt(database.transactionRowAverageBytes, "assumptions.database.transactionRowAverageBytes", { min: 1 }),
    importRowAverageBytes: numberAt(database.importRowAverageBytes, "assumptions.database.importRowAverageBytes", { min: 1 }),
    auditEventAverageBytes: numberAt(database.auditEventAverageBytes, "assumptions.database.auditEventAverageBytes", { min: 1 }),
    indexOverheadRatio: numberAt(database.indexOverheadRatio, "assumptions.database.indexOverheadRatio"),
    toastOverheadRatio: numberAt(database.toastOverheadRatio, "assumptions.database.toastOverheadRatio"),
    deadTupleHeadroomRatio: numberAt(database.deadTupleHeadroomRatio, "assumptions.database.deadTupleHeadroomRatio"),
    migrationHeadroomRatio: numberAt(database.migrationHeadroomRatio, "assumptions.database.migrationHeadroomRatio"),
  };

  const storage = objectAt(assumptions.storage, "assumptions.storage");
  const validatedStorage = {
    pdf: validateArtifact(storage.pdf, "assumptions.storage.pdf"),
    erp: validateArtifact(storage.erp, "assumptions.storage.erp"),
    importSource: validateArtifact(storage.importSource, "assumptions.storage.importSource"),
  };

  const backup = objectAt(assumptions.backup, "assumptions.backup");
  const validatedBackup = {
    generationsPerMonth: numberAt(backup.generationsPerMonth, "assumptions.backup.generationsPerMonth", {
      integer: true,
    }),
    averageDbDumpBytes: numberAt(backup.averageDbDumpBytes, "assumptions.backup.averageDbDumpBytes"),
    averageAuthDumpBytes: numberAt(backup.averageAuthDumpBytes, "assumptions.backup.averageAuthDumpBytes"),
    averageStorageIncrementalBytes: numberAt(
      backup.averageStorageIncrementalBytes,
      "assumptions.backup.averageStorageIncrementalBytes",
    ),
    archiveMetadataBytesPerGeneration: numberAt(
      backup.archiveMetadataBytesPerGeneration,
      "assumptions.backup.archiveMetadataBytesPerGeneration",
    ),
  };

  return {
    schemaVersion: SCHEMA_VERSION,
    projectionYears: PROJECTION_YEARS,
    evidence: {
      source,
      evidenceReference,
      syntheticThreeYearDbBytes,
      syntheticThreeYearStorageBytes,
      peakPerformancePassed,
      restoreDrillPassed,
      backupEgressQuotaRatio,
      actionsMinutesQuotaRatio,
    },
    assumptions: {
      entities: validatedEntities,
      annualTransactions: validatedAnnualTransactions,
      imports: validatedImports,
      auditAmplification,
      database: validatedDatabase,
      storage: validatedStorage,
      backup: validatedBackup,
    },
  };
}

function gateFor(bytes, quota) {
  let status = "PASS";
  if (bytes >= quota.suspendBytes) status = "SUSPEND";
  else if (bytes >= quota.decisionBytes) status = "DECISION";
  else if (bytes >= quota.warningBytes) status = "WARNING";
  return {
    status,
    bytes,
    quotaBytes: quota.quotaBytes,
    ratio: Number((bytes / quota.quotaBytes).toFixed(6)),
  };
}

function artifactProjectedBytes(artifact) {
  const retainedYears = Math.min(PROJECTION_YEARS, artifact.onlineRetentionMonths / 12);
  return Math.ceil(artifact.annualCount * artifact.averageBytes * retainedYears);
}

function calculatePlan(input) {
  const { assumptions, evidence } = input;
  const annualTransactionRows = Object.values(assumptions.annualTransactions).reduce((sum, value) => sum + value, 0);
  const transactionRows = annualTransactionRows * PROJECTION_YEARS;
  const importRows = assumptions.imports.perMonth * 12 * PROJECTION_YEARS * assumptions.imports.averageRows;
  const masterRows = assumptions.entities.year3Employees
    + assumptions.entities.institutions
    + assumptions.entities.departments
    + assumptions.entities.uniformItems;
  const auditEvents = Math.ceil((transactionRows + importRows) * assumptions.auditAmplification);

  const db = assumptions.database;
  const dbPayloadBytes = (
    masterRows * db.masterRowAverageBytes
    + transactionRows * db.transactionRowAverageBytes
    + importRows * db.importRowAverageBytes
    + importRows * assumptions.imports.averageRawJsonBytes
    + auditEvents * db.auditEventAverageBytes
  );
  const overheadRatio = db.indexOverheadRatio
    + db.toastOverheadRatio
    + db.deadTupleHeadroomRatio
    + db.migrationHeadroomRatio;
  const estimatedDbBytes = Math.ceil(dbPayloadBytes * (1 + overheadRatio));

  const storageComponents = {
    pdfBytes: artifactProjectedBytes(assumptions.storage.pdf),
    erpBytes: artifactProjectedBytes(assumptions.storage.erp),
    importSourceBytes: artifactProjectedBytes(assumptions.storage.importSource),
  };
  const estimatedStorageBytes = Object.values(storageComponents).reduce((sum, value) => sum + value, 0);

  const backup = assumptions.backup;
  const estimatedThirtyDayBackupBytes = Math.ceil(
    backup.generationsPerMonth
      * (backup.averageDbDumpBytes
        + backup.averageAuthDumpBytes
        + backup.averageStorageIncrementalBytes
        + backup.archiveMetadataBytesPerGeneration),
  );

  const estimateGates = {
    db: gateFor(estimatedDbBytes, QUOTAS.database),
    storage: gateFor(estimatedStorageBytes, QUOTAS.storage),
  };

  const measurementGates = {
    db: evidence.syntheticThreeYearDbBytes === null ? null : gateFor(evidence.syntheticThreeYearDbBytes, QUOTAS.database),
    storage: evidence.syntheticThreeYearStorageBytes === null
      ? null
      : gateFor(evidence.syntheticThreeYearStorageBytes, QUOTAS.storage),
  };

  const validationReasons = [];
  if (evidence.source !== "STAGING_SYNTHETIC") {
    validationReasons.push("staging synthetic measurement evidence is missing");
  } else {
    if (evidence.evidenceReference.length === 0) validationReasons.push("evidenceReference is missing");
    if (!measurementGates.db) validationReasons.push("syntheticThreeYearDbBytes is missing");
    if (!measurementGates.storage) validationReasons.push("syntheticThreeYearStorageBytes is missing");
    if (measurementGates.db && measurementGates.db.status !== "PASS") validationReasons.push("measured database gate is not PASS");
    if (measurementGates.storage && measurementGates.storage.status !== "PASS") validationReasons.push("measured Storage gate is not PASS");
    if (!evidence.peakPerformancePassed) validationReasons.push("peak performance evidence has not passed");
    if (!evidence.restoreDrillPassed) validationReasons.push("restore drill evidence has not passed");
    if (evidence.backupEgressQuotaRatio === null || evidence.backupEgressQuotaRatio >= 0.6) {
      validationReasons.push("30-day backup plus drill egress must be below 60% of quota");
    }
    if (evidence.actionsMinutesQuotaRatio === null || evidence.actionsMinutesQuotaRatio >= 0.6) {
      validationReasons.push("30-day GitHub Actions minutes must be below 60% of quota");
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    projectionYears: PROJECTION_YEARS,
    units: "decimal bytes (1 MB = 1,000,000 bytes; 1 GB = 1,000,000,000 bytes)",
    estimate: {
      modelOnly: true,
      masterRows,
      transactionRows,
      importRows,
      auditEvents,
      maximumImportRawJsonBytes: Math.ceil(assumptions.imports.maximumRows * assumptions.imports.averageRawJsonBytes),
      databaseBytes: estimatedDbBytes,
      storageBytes: estimatedStorageBytes,
      storageComponents,
      artifactP95Bytes: {
        pdf: assumptions.storage.pdf.p95Bytes,
        erp: assumptions.storage.erp.p95Bytes,
        importSource: assumptions.storage.importSource.p95Bytes,
      },
      thirtyDayBackupBytes: estimatedThirtyDayBackupBytes,
      gates: estimateGates,
    },
    measurement: {
      source: evidence.source,
      evidenceReference: evidence.evidenceReference,
      syntheticThreeYearDbBytes: evidence.syntheticThreeYearDbBytes,
      syntheticThreeYearStorageBytes: evidence.syntheticThreeYearStorageBytes,
      backupEgressQuotaRatio: evidence.backupEgressQuotaRatio,
      actionsMinutesQuotaRatio: evidence.actionsMinutesQuotaRatio,
      gates: measurementGates,
    },
    capacityValidation: {
      status: evidence.source === "STAGING_SYNTHETIC" && validationReasons.length === 0 ? "VALIDATED" : evidence.source === "STAGING_SYNTHETIC" ? "BLOCKED" : "NOT_VALIDATED",
      reasons: validationReasons,
    },
  };
}

function formatMb(bytes) {
  return `${(bytes / DECIMAL_MB).toFixed(2)} MB`;
}

function printHuman(result) {
  console.log("Uniform Co three-year capacity plan");
  console.log(`Estimated DB: ${formatMb(result.estimate.databaseBytes)} — ${result.estimate.gates.db.status}`);
  console.log(`Estimated Storage: ${formatMb(result.estimate.storageBytes)} — ${result.estimate.gates.storage.status}`);
  console.log(`Estimated 30-day backup bytes: ${formatMb(result.estimate.thirtyDayBackupBytes)}`);
  console.log("Estimate classification is model-only and is not pg_database_size or Storage measurement evidence.");
  if (result.measurement.gates.db) {
    console.log(`Measured synthetic DB: ${formatMb(result.measurement.syntheticThreeYearDbBytes)} — ${result.measurement.gates.db.status}`);
  }
  if (result.measurement.gates.storage) {
    console.log(`Measured synthetic Storage: ${formatMb(result.measurement.syntheticThreeYearStorageBytes)} — ${result.measurement.gates.storage.status}`);
  }
  console.log(`Capacity validation: ${result.capacityValidation.status}`);
  for (const reason of result.capacityValidation.reasons) console.log(`- ${reason}`);
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
    const result = calculatePlan(validateInput(parsed));
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else printHuman(result);
  } catch (error) {
    console.error(`Capacity plan rejected: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 2;
  }
}

await main();
