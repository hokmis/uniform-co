import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildBundle,
  buildVerificationSql,
  expectedBaseFunctions,
  expectedFunctions,
  expectedIndexes,
  expectedSourceRelations,
  expectedSourceViews,
  expectedViews,
  migrationFiles,
} from "./generate-production-read-model-sql.mjs";

test("production read-model SQL is assembled from the curated migrations in order", async () => {
  const sql = await buildBundle();
  let previousPosition = -1;

  for (const filename of migrationFiles) {
    const position = sql.indexOf(`-- Source: supabase/migrations/${filename}`);
    assert.notEqual(position, -1, `${filename} must be included`);
    assert.ok(position > previousPosition, `${filename} must stay in migration order`);
    previousPosition = position;
  }

  assert.equal((sql.match(/^begin;$/gim) ?? []).length, 1, "the bundle has one atomic transaction");
  assert.equal((sql.match(/^commit;$/gim) ?? []).length, 1, "the bundle has one atomic commit");
});

test("the generated repair verifies every advertised view, index, and RPC", async () => {
  const sql = await buildBundle();

  for (const name of expectedViews) {
    assert.ok(sql.includes(`('${name}')`), `${name} must be verified`);
  }
  for (const name of expectedIndexes) {
    assert.ok(sql.includes(`('${name}')`) || sql.includes(`'${name}'`), `${name} must be verified`);
  }
  for (const signature of expectedFunctions) {
    assert.ok(sql.includes(`('${signature}')`), `${signature} must be verified`);
  }

  assert.match(sql, /security_invoker=true/);
  assert.match(sql, /has_table_privilege\('authenticated'/);
  assert.match(sql, /has_function_privilege\('authenticated'/);
  assert.match(sql, /Read-model repair prerequisites are missing/);
  assert.match(sql, /Redundant master-data indexes remain/);
  assert.doesNotMatch(sql, /SUPABASE_SERVICE_ROLE_KEY|service_role key/i);
});

test("the production repair binds the overview snapshot to the current account", async () => {
  const repairSql = await buildBundle();
  const verificationSql = buildVerificationSql();

  assert.ok(migrationFiles.includes("0129_overview_core_account_binding.sql"));
  assert.ok(repairSql.includes("Source: supabase/migrations/0129_overview_core_account_binding.sql"));
  assert.match(repairSql, /Overview account snapshot binding is missing\./);
  assert.match(verificationSql, /overview_snapshot_account_bound/);
  assert.match(verificationSql, /attribute_row\.attname = 'account_id'/);
});

test("the repair and verifier include every optimized workflow RPC through migration 0132", async () => {
  const latestMigrations = [
    "0130_atomic_replenishment_submission.sql",
    "0131_atomic_correction_completion.sql",
    "0132_atomic_return_completion.sql",
  ];
  const optimizedRpcMigrations = {
    "submit_replenishment_request_with_lines(uuid,text,text,jsonb,text,text,text,text,text,text)": latestMigrations[0],
    "complete_return_correction(text,uuid,bigint,text,text,text,text,text,text)": latestMigrations[1],
    "complete_hr_issue_correction(text,uuid,bigint,text,text,text,text,text,text)": latestMigrations[1],
    "complete_warehouse_transfer_correction(text,text,uuid,bigint,text,text,text,text,text,text)": latestMigrations[1],
    "complete_purchase_receipt_correction(text,uuid,bigint,bigint,bigint,text,text,text,text,text,text)": latestMigrations[1],
    "complete_stocktake_correction(text,uuid,bigint,text,text,text,text,text,text)": latestMigrations[1],
    "complete_return_note(text,uuid,date,text,text,text,jsonb,text,text,text,text)": latestMigrations[2],
  };
  const repairSql = await buildBundle();
  const verificationSql = buildVerificationSql();

  assert.deepEqual(migrationFiles.slice(-3), latestMigrations);
  assert.equal(expectedFunctions.length, 13, "the readiness count includes all app-facing workflow RPCs");
  assert.equal(expectedBaseFunctions.length, 28, "the preflight covers all wrapper dependencies");
  for (const [signature, migration] of Object.entries(optimizedRpcMigrations)) {
    assert.ok(expectedFunctions.includes(signature), `${signature} must be part of the readiness gate`);
    assert.ok(repairSql.includes(`Source: supabase/migrations/${migration}`), `${signature} migration must be included`);
    assert.ok(verificationSql.includes(`('${signature}')`), `${signature} must be checked against production`);
  }
  assert.ok(expectedBaseFunctions.includes("public.submit_replenishment_request(uuid,text,text)"));
  assert.ok(expectedBaseFunctions.includes("public.create_return_note_draft(text,uuid,date,text,text,text,jsonb,text,text)"));
});

test("the verification artifact is read-only and checks the same objects as the repair", () => {
  const sql = buildVerificationSql();

  assert.match(sql, /^-- READ ONLY/m);
  assert.match(sql, /begin transaction read only;/i);
  assert.match(sql, /missing_source_relations/);
  assert.match(sql, /missing_base_functions/);
  assert.match(sql, /security_invoker=true/);
  assert.match(sql, /has_table_privilege\('authenticated'/);
  assert.match(sql, /has_function_privilege\('authenticated'/);
  assert.match(sql, /indexes_needing_attention/);
  assert.match(sql, /rpcs_needing_attention/);
  assert.match(sql, /redundant_indexes_remaining/);
  assert.doesNotMatch(sql, /\b(create|alter|drop|insert|update|delete|truncate)\b/i);

  for (const name of [...expectedSourceRelations, ...expectedSourceViews]) assert.ok(sql.includes(`('${name}')`), `${name} must be verified as a repair prerequisite`);
  for (const signature of expectedBaseFunctions) assert.ok(sql.includes(`('${signature}')`), `${signature} must be verified as a repair prerequisite`);
  for (const name of expectedViews) assert.ok(sql.includes(`('${name}')`), `${name} must be verified`);
  for (const name of expectedIndexes) assert.ok(sql.includes(`('${name}')`), `${name} must be verified`);
  for (const signature of expectedFunctions) assert.ok(sql.includes(`('${signature}')`), `${signature} must be verified`);
});

test("the checked-in SQL artifact is current with its migration sources", async () => {
  const checkedIn = await readFile("supabase/manual/restore-application-read-models.sql", "utf8");
  const checkedInVerification = await readFile("supabase/manual/verify-application-read-models.sql", "utf8");
  assert.equal(checkedIn, await buildBundle());
  assert.equal(checkedInVerification, buildVerificationSql());
});
