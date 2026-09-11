#!/usr/bin/env node

import { readdir } from "node:fs/promises";
import pg from "pg";

const { Client } = pg;

const REQUIRED_LOGIN_ROLES = [
  "job_import_worker",
  "job_document_renderer",
  "job_erp_renderer",
  "job_renderer_storage_proxy",
];
const REQUIRED_BOUND_ROLES = [
  ...REQUIRED_LOGIN_ROLES,
  "job_storage_cleanup",
  "job_import_retention",
];
const REQUIRED_BUCKETS = [
  "uniform-imports",
  "uniform-artifacts",
  "uniform-render-temp",
  "uniform-pdf",
  "uniform-erp",
];

const FUNCTION_GATES = [
  ["public.claim_import_chunk(uuid,text,integer,text,text)", "job_import_worker", true],
  ["public.claim_import_chunk(uuid,text,integer,text,text)", "authenticated", false],
  ["public.claim_import_apply(uuid,integer,text,text)", "job_import_worker", true],
  ["public.claim_import_apply(uuid,integer,text,text)", "authenticated", false],
  ["public.confirm_import_batch(uuid,text,text)", "authenticated", true],
  ["public.confirm_import_batch(uuid,text,text)", "anon", false],
  ["public.claim_document_render_attempt(integer)", "job_document_renderer", true],
  ["public.claim_document_render_attempt(integer)", "authenticated", false],
  ["public.get_document_render_payload(uuid,text,bigint)", "job_document_renderer", true],
  ["public.finalize_document_render_attempt(uuid,text,bigint,text,text,bigint)", "job_document_renderer", true],
  ["public.claim_erp_render_attempt(integer)", "job_erp_renderer", true],
  ["public.claim_erp_render_attempt(integer)", "authenticated", false],
  ["public.get_erp_render_payload(uuid,text,bigint)", "job_erp_renderer", true],
  ["public.finalize_erp_render_attempt(uuid,text,bigint,text,text,bigint)", "job_erp_renderer", true],
  ["public.download_document(uuid)", "authenticated", true],
  ["public.download_document(uuid)", "anon", false],
  ["public.download_erp_artifact(uuid,uuid)", "authenticated", true],
  ["public.download_erp_artifact(uuid,uuid)", "anon", false],
  ["private.renderer_storage_capability(text,text,uuid,text,bigint)", "job_renderer_storage_proxy", true],
  ["private.import_storage_capability(uuid,text,text)", "job_renderer_storage_proxy", true],
  ["public.list_import_staging_retention_candidates(integer)", "job_import_retention", true],
  ["public.list_import_staging_retention_candidates(integer)", "authenticated", false],
  ["public.purge_import_staging_payload(uuid)", "job_import_retention", true],
  ["public.purge_import_staging_payload(uuid)", "authenticated", false],
];

const checks = [];

function record(group, label, ok, detail = "") {
  checks.push({ group, label, ok, detail });
}

function failClosed(message) {
  console.error(`FAIL [safety] ${message}`);
  console.error("No secret values were printed and no database query was executed.");
  process.exit(2);
}

function getDatabaseUrl() {
  if (process.env.UNIFORM_DEPLOYMENT_ENV !== "staging") {
    failClosed("UNIFORM_DEPLOYMENT_ENV must equal staging");
  }
  if (process.env.UNIFORM_STAGING_SMOKE_CONFIRM !== "YES") {
    failClosed("UNIFORM_STAGING_SMOKE_CONFIRM must equal YES");
  }
  const value = process.env.STAGING_DATABASE_URL?.trim();
  if (!value) failClosed("STAGING_DATABASE_URL is required");
  try {
    const url = new URL(value);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
      failClosed("STAGING_DATABASE_URL must be a PostgreSQL URL");
    }
  } catch {
    failClosed("STAGING_DATABASE_URL is not a valid URL");
  }
  return value;
}

async function expectedMigrationVersions() {
  const files = await readdir(new URL("../../supabase/migrations/", import.meta.url));
  return files
    .map((name) => /^(\d+)_.*\.sql$/.exec(name)?.[1])
    .filter(Boolean)
    .sort();
}

function printSummary() {
  console.log("Uniform Co staging DB smoke readiness");
  for (const check of checks) {
    const marker = check.ok ? "PASS" : "FAIL";
    const suffix = check.detail ? ` — ${check.detail}` : "";
    console.log(`${marker} [${check.group}] ${check.label}${suffix}`);
  }
  const failures = checks.filter((check) => !check.ok);
  console.log(`Summary: ${checks.length - failures.length} passed, ${failures.length} failed.`);
  console.log("No environment variable values or database credentials were printed.");
  console.log("This command is read-only. Active fixture scenarios remain mandatory before production cutover.");
  if (failures.length > 0) process.exitCode = 1;
}

async function main() {
  const databaseUrl = getDatabaseUrl();
  const expectedVersions = await expectedMigrationVersions();
  const client = new Client({ connectionString: databaseUrl, application_name: "uniform-staging-smoke-readiness" });

  try {
    await client.connect();
    await client.query("begin read only");

    const identity = await client.query(
      "select current_database() as database_name, current_user as current_user, session_user as session_user",
    );
    record("connection", "connected to PostgreSQL in a READ ONLY transaction", identity.rowCount === 1);

    const migrationRows = await client.query(
      "select version::text as version from supabase_migrations.schema_migrations order by version::text",
    );
    const actualVersions = new Set(migrationRows.rows.map((row) => row.version));
    const missingVersions = expectedVersions.filter((version) => !actualVersions.has(version));
    record(
      "migration",
      `all ${expectedVersions.length} repository migrations are applied`,
      missingVersions.length === 0,
      missingVersions.length === 0 ? "" : `missing versions: ${missingVersions.join(", ")}`,
    );

    const roleRows = await client.query(
      "select rolname, rolcanlogin, rolinherit from pg_roles where rolname = any($1::text[])",
      [REQUIRED_BOUND_ROLES],
    );
    const roles = new Map(roleRows.rows.map((row) => [row.rolname, row]));
    for (const roleName of REQUIRED_BOUND_ROLES) {
      const role = roles.get(roleName);
      record("worker-role", `${roleName} exists`, Boolean(role));
      if (!role) continue;
      record("worker-role", `${roleName} is NOINHERIT`, role.rolinherit === false);
      if (REQUIRED_LOGIN_ROLES.includes(roleName)) {
        record("worker-role", `${roleName} LOGIN is enabled for staging smoke`, role.rolcanlogin === true);
      }
    }

    const bindingRows = await client.query(
      `select b.db_role::text as db_role, b.is_active as binding_active, a.is_active as account_active
       from private.job_actor_bindings b
       join public.app_accounts a on a.id = b.account_id
       where b.db_role::text = any($1::text[])`,
      [REQUIRED_BOUND_ROLES],
    );
    const bindings = new Map(bindingRows.rows.map((row) => [row.db_role, row]));
    for (const roleName of REQUIRED_BOUND_ROLES) {
      const binding = bindings.get(roleName);
      record(
        "worker-binding",
        `${roleName} has an active audit actor binding`,
        Boolean(binding?.binding_active && binding?.account_active),
      );
    }

    for (const [signature, roleName, expected] of FUNCTION_GATES) {
      const result = await client.query(
        `select to_regprocedure($1) is not null as function_exists,
                case when to_regprocedure($1) is null then false
                     else has_function_privilege($2::name, to_regprocedure($1)::oid, 'EXECUTE') end as can_execute`,
        [signature, roleName],
      );
      const row = result.rows[0];
      record("rpc", `${signature} exists`, row.function_exists === true);
      if (row.function_exists) {
        record(
          "rpc-acl",
          `${roleName} ${expected ? "can" : "cannot"} execute ${signature}`,
          row.can_execute === expected,
        );
      }
    }

    const storagePrivileges = await client.query(
      `select r.rolname,
              has_table_privilege(r.rolname, 'storage.objects', 'SELECT') as can_select,
              has_table_privilege(r.rolname, 'storage.objects', 'INSERT') as can_insert,
              has_table_privilege(r.rolname, 'storage.objects', 'UPDATE') as can_update,
              has_table_privilege(r.rolname, 'storage.objects', 'DELETE') as can_delete
       from pg_roles r where r.rolname = any($1::text[])`,
      [["job_document_renderer", "job_erp_renderer"]],
    );
    for (const row of storagePrivileges.rows) {
      record(
        "storage-acl",
        `${row.rolname} has no direct storage.objects DML`,
        !row.can_select && !row.can_insert && !row.can_update && !row.can_delete,
      );
    }

    const bucketRows = await client.query(
      "select id, public from storage.buckets where id = any($1::text[])",
      [REQUIRED_BUCKETS],
    );
    const buckets = new Map(bucketRows.rows.map((row) => [row.id, row]));
    for (const bucketName of REQUIRED_BUCKETS) {
      const bucket = buckets.get(bucketName);
      record("storage", `${bucketName} bucket exists and is private`, Boolean(bucket && bucket.public === false));
    }

    const triggerRows = await client.query(
      `select tgname, tgrelid::regclass::text as table_name, tgenabled
       from pg_trigger
       where not tgisinternal and tgname = any($1::text[])`,
      [["renderer_generation_object_key", "erp_renderer_generation_object_key"]],
    );
    const triggers = new Map(triggerRows.rows.map((row) => [row.tgname, row]));
    for (const triggerName of ["renderer_generation_object_key", "erp_renderer_generation_object_key"]) {
      const trigger = triggers.get(triggerName);
      record("renderer-fence", `${triggerName} exists and is enabled`, Boolean(trigger && trigger.tgenabled !== "D"));
    }

    const grantRlsRows = await client.query(
      `select c.relname, c.relrowsecurity
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = any($1::text[])`,
      [["document_download_grants", "erp_download_grants"]],
    );
    const grantTables = new Map(grantRlsRows.rows.map((row) => [row.relname, row]));
    for (const tableName of ["document_download_grants", "erp_download_grants"]) {
      const table = grantTables.get(tableName);
      record("download", `${tableName} exists with RLS enabled`, Boolean(table?.relrowsecurity));
    }

    const cutoverRows = await client.query(
      "select status, opening_import_batch_id, opening_posting_id from public.system_cutover_state where id = 1",
    );
    const cutover = cutoverRows.rows[0];
    record("cutover", "system_cutover_state singleton exists", cutoverRows.rowCount === 1);
    if (cutoverRows.rowCount === 1) {
      record(
        "cutover",
        "staging baseline is PRE_CUTOVER before the once-only opening-balance scenario",
        cutover.status === "PRE_CUTOVER" && cutover.opening_import_batch_id === null && cutover.opening_posting_id === null,
        cutover.status === "PRE_CUTOVER" ? "" : `current status is ${cutover.status}`,
      );
    }

    await client.query("rollback");
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // The connection may already be closed or the transaction may not exist.
    }
    record("database", "read-only staging assertions completed", false, error instanceof Error ? error.message : String(error));
  } finally {
    await client.end().catch(() => {});
  }

  printSummary();
}

await main();
