#!/usr/bin/env node

const VALID_SCOPES = new Set(["smoke", "backup", "restore", "cleanup", "import-retention", "all"]);
const scopeArg = process.argv.find((value) => value.startsWith("--scope="));
const scope = scopeArg?.slice("--scope=".length) || "smoke";

if (!VALID_SCOPES.has(scope)) {
  console.error(`Unknown scope: ${scope}. Use smoke, backup, restore, cleanup, import-retention, or all.`);
  process.exit(2);
}

const checks = [];
const env = process.env;

function has(name) {
  return typeof env[name] === "string" && env[name].trim().length > 0;
}

function add(group, label, ok, hint) {
  checks.push({ group, label, ok, hint });
}

function requireValue(group, name) {
  add(group, name, has(name), `set ${name}`);
}

function requireOne(group, names, label = names.join(" or ")) {
  add(group, label, names.some(has), `set one of: ${names.join(", ")}`);
}

function requireExact(group, name, expected) {
  add(group, `${name}=${expected}`, env[name] === expected, `set ${name}=${expected}`);
}

function requireUrl(group, name) {
  if (!has(name)) return;
  let ok = false;
  try {
    const value = new URL(env[name]);
    ok = value.protocol === "http:" || value.protocol === "https:";
  } catch {
    ok = false;
  }
  add(group, `${name} is an HTTP(S) URL`, ok, `fix ${name} format`);
}

function requireDatabaseUrl(group, names, label) {
  const selected = names.find(has);
  if (!selected) return;
  let ok = false;
  try {
    const value = new URL(env[selected]);
    ok = value.protocol === "postgres:" || value.protocol === "postgresql:";
  } catch {
    ok = false;
  }
  add(group, `${label} is a PostgreSQL URL`, ok, `fix ${selected} format`);
}

function requireDatabaseUsername(group, name, expected) {
  if (!has(name)) return;
  let ok = false;
  try {
    const value = new URL(env[name]);
    ok = decodeURIComponent(value.username) === expected;
  } catch {
    ok = false;
  }
  add(group, `${name} username is ${expected}`, ok, `use the protected ${expected} login URL`);
}

function checkRendererArgs() {
  if (!has("RENDER_COMMAND_ARGS")) return;
  let ok = false;
  try {
    const parsed = JSON.parse(env.RENDER_COMMAND_ARGS);
    ok = Array.isArray(parsed) && parsed.every((value) => typeof value === "string");
  } catch {
    ok = false;
  }
  add("renderer", "RENDER_COMMAND_ARGS is a JSON string array", ok, "use a JSON string array such as [\"adapter.mjs\"]");
}

function checkStoragePort() {
  if (!has("RENDER_STORAGE_PROXY_PORT")) return;
  const value = Number(env.RENDER_STORAGE_PROXY_PORT);
  add("storage-proxy", "RENDER_STORAGE_PROXY_PORT is 1..65535", Number.isInteger(value) && value >= 1 && value <= 65535, "set a valid TCP port or omit it to use 8787");
}

function checkBackupBuckets() {
  const required = ["uniform-imports", "uniform-artifacts", "uniform-render-temp", "uniform-pdf", "uniform-erp"];
  if (!has("BACKUP_STORAGE_BUCKETS")) return;
  const actual = env.BACKUP_STORAGE_BUCKETS.split(",").map((value) => value.trim()).filter(Boolean);
  const ok = actual.length === required.length && new Set(actual).size === required.length && required.every((value) => actual.includes(value));
  add("backup", "BACKUP_STORAGE_BUCKETS contains the exact private bucket allowlist", ok, `set exactly: ${required.join(",")}`);
}

function checkCommandPositionalArgs(group, name, positions) {
  if (!has(name)) return;
  const command = env[name];
  const missing = positions.filter((position) => !command.includes(`$${position}`) && !command.includes(`\${${position}}`));
  add(
    group,
    `${name} uses ${positions.map((position) => `$${position}`).join(" and ")} positional arguments`,
    missing.length === 0,
    `update ${name} to read ${positions.map((position) => `$${position}`).join(" and ")} supplied by the wrapper`,
  );
}

function checkPublicSecretExposure() {
  const dangerous = Object.keys(env).filter((name) => name.startsWith("NEXT_PUBLIC_") && /(SERVICE_ROLE|SECRET|ADMIN|DATABASE|PASSWORD|TOKEN)/i.test(name) && has(name));
  add("safety", "no privileged secret is exposed through NEXT_PUBLIC_*", dangerous.length === 0, dangerous.length === 0 ? "" : `remove privileged public env names: ${dangerous.join(", ")}`);
}

function addSmokeChecks() {
  requireValue("migration", "SUPABASE_ACCESS_TOKEN");
  requireValue("migration", "SUPABASE_PROJECT_REF");
  requireValue("migration", "SUPABASE_DB_PASSWORD");

  requireValue("web", "NEXT_PUBLIC_SUPABASE_URL");
  requireUrl("web", "NEXT_PUBLIC_SUPABASE_URL");
  requireValue("web", "NEXT_PUBLIC_SUPABASE_ANON_KEY");
  requireOne("web", ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY"], "server-only Supabase Auth admin key");

  requireOne("import", ["IMPORT_WORKER_DATABASE_URL", "DATABASE_URL"], "import worker database URL");
  requireDatabaseUrl("import", ["IMPORT_WORKER_DATABASE_URL", "DATABASE_URL"], "import worker database URL");
  requireOne("import", ["IMPORT_STORAGE_PROXY_URL", "RENDER_STORAGE_PROXY_URL"], "import storage proxy URL");
  const importProxyUrl = ["IMPORT_STORAGE_PROXY_URL", "RENDER_STORAGE_PROXY_URL"].find(has);
  if (importProxyUrl) requireUrl("import", importProxyUrl);
  requireOne("import", ["IMPORT_STORAGE_PROXY_TOKEN", "RENDER_STORAGE_PROXY_TOKEN"], "import storage proxy token");

  requireValue("renderer", "DATABASE_URL");
  requireDatabaseUrl("renderer", ["DATABASE_URL"], "renderer database URL");
  requireValue("renderer", "RENDER_STORAGE_PROXY_URL");
  requireUrl("renderer", "RENDER_STORAGE_PROXY_URL");
  requireValue("renderer", "RENDER_STORAGE_PROXY_TOKEN");
  requireValue("renderer", "RENDER_COMMAND");
  checkRendererArgs();

  requireValue("storage-proxy", "RENDER_STORAGE_PROXY_TOKEN");
  requireValue("storage-proxy", "RENDER_STORAGE_PROXY_DATABASE_URL");
  requireDatabaseUrl("storage-proxy", ["RENDER_STORAGE_PROXY_DATABASE_URL"], "storage proxy database URL");
  requireValue("storage-proxy", "SUPABASE_URL");
  requireUrl("storage-proxy", "SUPABASE_URL");
  requireValue("storage-proxy", "SUPABASE_STORAGE_ADMIN_KEY");
  checkStoragePort();
}

function addBackupChecks() {
  requireValue("backup", "SUPABASE_DB_URL");
  requireDatabaseUrl("backup", ["SUPABASE_DB_URL"], "backup database URL");
  requireValue("backup", "SUPABASE_URL");
  requireUrl("backup", "SUPABASE_URL");
  requireValue("backup", "SUPABASE_SERVICE_ROLE_KEY");
  requireValue("backup", "BACKUP_ROOT");
  requireValue("backup", "BACKUP_STORAGE_BUCKETS");
  checkBackupBuckets();
  requireValue("backup", "BACKUP_ENCRYPT_COMMAND");
  checkCommandPositionalArgs("backup", "BACKUP_ENCRYPT_COMMAND", [1, 2]);
  requireValue("backup", "BACKUP_OFFSITE_COMMAND");
  checkCommandPositionalArgs("backup", "BACKUP_OFFSITE_COMMAND", [1, 2]);
}

function addRestoreChecks() {
  requireValue("restore", "BACKUP_RUN_DIR");
  requireValue("restore", "TARGET_DATABASE_URL");
  requireDatabaseUrl("restore", ["TARGET_DATABASE_URL"], "restore target database URL");
  requireValue("restore", "BACKUP_DECRYPT_COMMAND");
  checkCommandPositionalArgs("restore", "BACKUP_DECRYPT_COMMAND", [1]);
  requireValue("restore", "SUPABASE_URL");
  requireUrl("restore", "SUPABASE_URL");
  requireValue("restore", "SUPABASE_SERVICE_ROLE_KEY");
}

function addCleanupChecks() {
  requireValue("cleanup", "CLEANUP_DATABASE_URL");
  requireDatabaseUrl("cleanup", ["CLEANUP_DATABASE_URL"], "cleanup database URL");
  requireDatabaseUsername("cleanup", "CLEANUP_DATABASE_URL", "job_storage_cleanup");

  const hasStorageUrl = has("CLEANUP_SUPABASE_URL");
  const hasStorageKey = has("CLEANUP_STORAGE_ADMIN_KEY");
  if (hasStorageUrl || hasStorageKey) {
    requireValue("cleanup", "CLEANUP_SUPABASE_URL");
    requireUrl("cleanup", "CLEANUP_SUPABASE_URL");
    requireValue("cleanup", "CLEANUP_STORAGE_ADMIN_KEY");
  }
}

function addImportRetentionChecks() {
  requireValue("import-retention", "IMPORT_RETENTION_DATABASE_URL");
  requireDatabaseUrl("import-retention", ["IMPORT_RETENTION_DATABASE_URL"], "import retention database URL");
  requireDatabaseUsername("import-retention", "IMPORT_RETENTION_DATABASE_URL", "job_import_retention");
}

requireExact("safety", "UNIFORM_DEPLOYMENT_ENV", "staging");
checkPublicSecretExposure();

if (scope === "smoke" || scope === "all") addSmokeChecks();
if (scope === "backup" || scope === "all") addBackupChecks();
if (scope === "restore" || scope === "all") addRestoreChecks();
if (scope === "cleanup" || scope === "all") addCleanupChecks();
if (scope === "import-retention" || scope === "all") addImportRetentionChecks();

console.log(`Uniform Co staging preflight (scope=${scope})`);
for (const check of checks) {
  const marker = check.ok ? "PASS" : "FAIL";
  const suffix = check.ok || !check.hint ? "" : ` — ${check.hint}`;
  console.log(`${marker} [${check.group}] ${check.label}${suffix}`);
}

const failures = checks.filter((check) => !check.ok);
console.log(`Summary: ${checks.length - failures.length} passed, ${failures.length} failed.`);
console.log("No environment variable values were printed.");

if (scope === "restore") {
  console.log("Restore safety gate: set CONFIRM_RESTORE=YES only immediately before the destructive restore command; preflight does not require or persist it.");
}

if (failures.length > 0) process.exitCode = 1;
