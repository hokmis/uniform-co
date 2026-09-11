#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const runDir = resolve(process.argv[2] ?? process.env.BACKUP_RUN_DIR ?? "");
const validateOnly = process.argv.includes("--validate-only");
const observedJsonIndex = process.argv.indexOf("--observed-json");
const observedJsonPath = observedJsonIndex >= 0 ? process.argv[observedJsonIndex + 1] : undefined;

if (!runDir || runDir === resolve(".")) throw new Error("BACKUP_RUN_DIR is required");
if (observedJsonIndex >= 0 && !observedJsonPath) throw new Error("--observed-json requires a path");
if (validateOnly && observedJsonPath) throw new Error("--validate-only cannot be combined with --observed-json");

async function readJson(path, label) {
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is missing or invalid JSON`, { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function nonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return value;
}

const applicationCountKeys = [
  "app_accounts",
  "employees",
  "inventory_balances",
  "inventory_ledger_entries",
  "operation_commands",
  "document_artifacts",
  "erp_export_artifacts",
  "import_batches",
];

function applicationCounts(value, label, { optional = false } = {}) {
  if (value === undefined && optional) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  const counts = {};
  for (const key of applicationCountKeys) {
    counts[key] = nonNegativeSafeInteger(value[key], `${label} ${key}`);
  }
  return counts;
}

function expectedMetadata(databaseMetadata, authMetadata) {
  if (typeof databaseMetadata.migration_head !== "string") {
    throw new Error("database-metadata.json migration_head must be a string");
  }
  nonNegativeSafeInteger(databaseMetadata.database_size_bytes, "database-metadata.json database_size_bytes");
  return {
    migration_head: databaseMetadata.migration_head,
    application_counts: applicationCounts(databaseMetadata.application_counts, "database-metadata.json application_counts", { optional: true }),
    users: nonNegativeSafeInteger(authMetadata.users, "auth-metadata.json users"),
    identities: nonNegativeSafeInteger(authMetadata.identities, "auth-metadata.json identities"),
    mfa_factors: nonNegativeSafeInteger(authMetadata.mfa_factors, "auth-metadata.json mfa_factors"),
  };
}

function validateObserved(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Observed restore metadata must be a JSON object");
  return {
    application_counts: applicationCounts(value.application_counts, "Observed application_counts", { optional: true }),
    users: nonNegativeSafeInteger(value.users, "Observed users"),
    identities: nonNegativeSafeInteger(value.identities, "Observed identities"),
    mfa_factors: nonNegativeSafeInteger(value.mfa_factors, "Observed mfa_factors"),
  };
}

const databaseMetadata = await readJson(resolve(runDir, "database-metadata.json"), "database-metadata.json");
const authMetadata = await readJson(resolve(runDir, "auth-metadata.json"), "auth-metadata.json");
const expected = expectedMetadata(databaseMetadata, authMetadata);

if (validateOnly) {
  console.log("validated_restore_metadata=database-metadata.json,auth-metadata.json");
  process.exit(0);
}

let observed;
if (observedJsonPath) {
  observed = validateObserved(await readJson(resolve(observedJsonPath), "Observed restore metadata"));
} else {
  const targetDatabaseUrl = process.env.TARGET_DATABASE_URL;
  if (!targetDatabaseUrl) throw new Error("TARGET_DATABASE_URL is required");

  const query = `
do $$
begin
  if to_regclass('auth.users') is null
    or to_regclass('auth.identities') is null
    or to_regclass('auth.mfa_factors') is null then
    raise exception 'restore metadata verification requires Auth baseline tables';
  end if;
end
$$;
select json_build_object(
  'users', (select count(*) from auth.users),
  'identities', (select count(*) from auth.identities),
  'mfa_factors', (select count(*) from auth.mfa_factors),
  'application_counts', json_build_object(
    'app_accounts', (select count(*) from public.app_accounts),
    'employees', (select count(*) from public.employees),
    'inventory_balances', (select count(*) from public.inventory_balances),
    'inventory_ledger_entries', (select count(*) from public.inventory_ledger_entries),
    'operation_commands', (select count(*) from public.operation_commands),
    'document_artifacts', (select count(*) from public.document_artifacts),
    'erp_export_artifacts', (select count(*) from public.erp_export_artifacts),
    'import_batches', (select count(*) from public.import_batches)
  )
);
`;
  const result = spawnSync("psql", [
    "--no-psqlrc",
    "--quiet",
    "--tuples-only",
    "--no-align",
    "--set",
    "ON_ERROR_STOP=1",
    targetDatabaseUrl,
    "--command",
    query,
  ], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.stderr?.trim();
    throw new Error(detail ? `Restore metadata query failed: ${detail}` : "Restore metadata query failed");
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new Error("Restore metadata query returned invalid JSON", { cause: error });
  }
  observed = validateObserved(parsed);
}

for (const key of ["users", "identities", "mfa_factors"]) {
  if (observed[key] !== expected[key]) {
    throw new Error(`Restore metadata mismatch for ${key}: expected ${expected[key]}, observed ${observed[key]}`);
  }
}

if (expected.application_counts) {
  if (!observed.application_counts) throw new Error("Observed restore metadata is missing application_counts");
  for (const key of applicationCountKeys) {
    if (observed.application_counts[key] !== expected.application_counts[key]) {
      throw new Error(`Restore metadata mismatch for application_counts.${key}: expected ${expected.application_counts[key]}, observed ${observed.application_counts[key]}`);
    }
  }
}

console.log(`verified_restore_metadata=users:${observed.users},identities:${observed.identities},mfa_factors:${observed.mfa_factors},application_counts:${expected.application_counts ? "verified" : "legacy-unavailable"}`);
