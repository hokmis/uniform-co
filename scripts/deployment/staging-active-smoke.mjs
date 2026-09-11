#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import pg from "pg";

const { Client } = pg;

const VALID_SCOPES = new Set(["import", "cutover", "all"]);
const scopeArg = process.argv.find((value) => value.startsWith("--scope="));
const scope = scopeArg?.slice("--scope=".length) || "import";
const runImport = scope === "import" || scope === "all";
const runCutover = scope === "cutover" || scope === "all";

const ACTIVE_CONFIRM = "DISPOSABLE_STAGING_ONLY";
const CUTOVER_CONFIRM = "ONCE_ONLY_OPENING_BALANCE";
const checks = [];

function record(group, label, ok, detail = "") {
  checks.push({ group, label, ok, detail });
  const marker = ok ? "PASS" : "FAIL";
  const suffix = detail ? ` — ${detail}` : "";
  console.log(`${marker} [${group}] ${label}${suffix}`);
}

function failClosed(message) {
  console.error(`FAIL [safety] ${message}`);
  console.error("No database connection was opened and no secret value was printed.");
  process.exit(2);
}

function requirePostgresUrl(name) {
  const value = process.env[name]?.trim();
  if (!value) failClosed(`${name} is required`);
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      failClosed(`${name} must be a PostgreSQL URL`);
    }
  } catch {
    failClosed(`${name} is not a valid URL`);
  }
  return value;
}

function readConfig() {
  if (!VALID_SCOPES.has(scope)) {
    failClosed(`Unknown scope: ${scope}. Use import, cutover, or all.`);
  }
  if (process.env.UNIFORM_DEPLOYMENT_ENV !== "staging") {
    failClosed("UNIFORM_DEPLOYMENT_ENV must equal staging");
  }
  if (process.env.UNIFORM_STAGING_SMOKE_CONFIRM !== "YES") {
    failClosed("UNIFORM_STAGING_SMOKE_CONFIRM must equal YES");
  }
  if (process.env.UNIFORM_STAGING_ACTIVE_SMOKE_CONFIRM !== ACTIVE_CONFIRM) {
    failClosed(`UNIFORM_STAGING_ACTIVE_SMOKE_CONFIRM must equal ${ACTIVE_CONFIRM}`);
  }
  if (runCutover && process.env.UNIFORM_STAGING_CUTOVER_SMOKE_CONFIRM !== CUTOVER_CONFIRM) {
    failClosed(`UNIFORM_STAGING_CUTOVER_SMOKE_CONFIRM must equal ${CUTOVER_CONFIRM}`);
  }

  return {
    maintenanceUrl: requirePostgresUrl("STAGING_DATABASE_URL"),
    importWorkerUrl: requirePostgresUrl("IMPORT_WORKER_DATABASE_URL"),
  };
}

function sqlState(error) {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

async function expectSqlState(group, label, expectedCode, action) {
  try {
    await action();
  } catch (error) {
    const actual = sqlState(error);
    const ok = actual === expectedCode;
    record(group, label, ok, ok ? `rejected with SQLSTATE ${expectedCode}` : `expected ${expectedCode}, received ${actual || "unknown"}`);
    if (!ok) throw error;
    return;
  }
  record(group, label, false, `expected SQLSTATE ${expectedCode}, but the operation succeeded`);
  throw new Error(`${label} unexpectedly succeeded`);
}

function assertCheck(group, label, condition, detail = "") {
  record(group, label, Boolean(condition), detail);
  if (!condition) throw new Error(label);
}

async function setFixtureClaims(client, authUserId, isLocal = true) {
  const claims = JSON.stringify({ sub: authUserId, role: "authenticated" });
  await client.query(
    "select set_config('request.jwt.claims', $1, $3), set_config('request.jwt.claim.sub', $2, $3)",
    [claims, authUserId, isLocal],
  );
}

async function ownerTransactionAs(client, authUserId, action) {
  await client.query("begin");
  try {
    await setFixtureClaims(client, authUserId, true);
    const result = await action(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

async function authenticatedTransaction(client, authUserId, action) {
  await client.query("begin");
  try {
    await setFixtureClaims(client, authUserId, true);
    await client.query("set local role authenticated");
    const result = await action(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

async function fingerprint(client, expression, values) {
  const result = await client.query(
    `select encode(digest((${expression})::text, 'sha256'), 'hex') as fingerprint`,
    values,
  );
  return result.rows[0].fingerprint;
}

function claimChunkFingerprint(client, batchId, phase, leaseSeconds) {
  return fingerprint(
    client,
    "jsonb_build_object('batch_id', $1::uuid, 'phase', $2::text, 'lease_seconds', $3::integer)",
    [batchId, phase, leaseSeconds],
  );
}

function completeChunkFingerprint(client, chunk, rows) {
  return fingerprint(
    client,
    "jsonb_build_object('chunk_id', $1::uuid, 'lease_generation', $2::bigint, 'cursor_version', $3::bigint, 'rows', $4::jsonb)",
    [chunk.id, chunk.lease_generation, chunk.cursor_version, JSON.stringify(rows)],
  );
}

function failChunkFingerprint(client, chunk, errorCode, errorMessage, retryable) {
  return fingerprint(
    client,
    "jsonb_build_object('chunk_id', $1::uuid, 'lease_generation', $2::bigint, 'cursor_version', $3::bigint, 'error_code', left(btrim($4::text), 100), 'error_message', left(btrim(coalesce($5::text, '')), 500), 'retryable', coalesce($6::boolean, false))",
    [chunk.id, chunk.lease_generation, chunk.cursor_version, errorCode, errorMessage, retryable],
  );
}

function confirmBatchFingerprint(client, batchId) {
  return fingerprint(client, "jsonb_build_object('batch_id', $1::uuid)", [batchId]);
}

function claimApplyFingerprint(client, batchId, leaseSeconds) {
  return fingerprint(
    client,
    "jsonb_build_object('batch_id', $1::uuid, 'lease_seconds', $2::integer)",
    [batchId, leaseSeconds],
  );
}

function applyBatchFingerprint(client, batch) {
  return fingerprint(
    client,
    "jsonb_build_object('batch_id', $1::uuid, 'lease_generation', $2::bigint, 'cursor_version', $3::bigint)",
    [batch.id, batch.lease_generation, batch.cursor_version],
  );
}

async function claimChunk(owner, worker, runId, batchId, phase, keySuffix, leaseSeconds = 60) {
  const requestFingerprint = await claimChunkFingerprint(owner, batchId, phase, leaseSeconds);
  const result = await worker.query(
    "select * from public.claim_import_chunk($1::uuid, $2::text, $3::integer, $4::text, $5::text)",
    [batchId, phase, leaseSeconds, `smoke-${runId}-${keySuffix}`, requestFingerprint],
  );
  return result.rows[0];
}

async function completeChunk(owner, worker, runId, chunk, rows, keySuffix) {
  const requestFingerprint = await completeChunkFingerprint(owner, chunk, rows);
  const result = await worker.query(
    "select * from public.complete_import_chunk($1::uuid, $2::text, $3::bigint, $4::bigint, $5::jsonb, $6::text, $7::text)",
    [
      chunk.id,
      chunk.lease_token,
      chunk.lease_generation,
      chunk.cursor_version,
      JSON.stringify(rows),
      `smoke-${runId}-${keySuffix}`,
      requestFingerprint,
    ],
  );
  return result.rows[0];
}

async function confirmBatch(owner, authUserId, runId, batchId, keySuffix) {
  const requestFingerprint = await confirmBatchFingerprint(owner, batchId);
  return authenticatedTransaction(owner, authUserId, async (client) => {
    const result = await client.query(
      "select * from public.confirm_import_batch($1::uuid, $2::text, $3::text)",
      [batchId, `smoke-${runId}-${keySuffix}`, requestFingerprint],
    );
    return result.rows[0];
  });
}

async function claimApply(owner, worker, runId, batchId, keySuffix, leaseSeconds = 120) {
  const requestFingerprint = await claimApplyFingerprint(owner, batchId, leaseSeconds);
  const result = await worker.query(
    "select * from public.claim_import_apply($1::uuid, $2::integer, $3::text, $4::text)",
    [batchId, leaseSeconds, `smoke-${runId}-${keySuffix}`, requestFingerprint],
  );
  return result.rows[0];
}

async function applyBatch(owner, worker, runId, batch, keySuffix) {
  const requestFingerprint = await applyBatchFingerprint(owner, batch);
  const result = await worker.query(
    "select * from public.apply_import_batch($1::uuid, $2::text, $3::bigint, $4::bigint, $5::text, $6::text)",
    [
      batch.id,
      batch.lease_token,
      batch.lease_generation,
      batch.cursor_version,
      `smoke-${runId}-${keySuffix}`,
      requestFingerprint,
    ],
  );
  return result.rows[0];
}

async function createSyntheticActor(owner, runId) {
  const authUserId = randomUUID();
  const loginName = `smoke.${runId.slice(0, 12)}`;
  const account = await owner.query(
    `insert into public.app_accounts (auth_user_id, login_name, display_name, email_snapshot, is_active)
     values ($1::uuid, $2::text, $3::text, null, true)
     returning id`,
    [authUserId, loginName, `Staging Active Smoke ${runId.slice(0, 8)}`],
  );
  const accountId = account.rows[0].id;
  await owner.query(
    `insert into public.user_roles (account_id, role_code)
     values ($1::uuid, 'HR'), ($1::uuid, 'SYSTEM_ADMIN')`,
    [accountId],
  );
  return { accountId, authUserId };
}

async function createMasterFixture(owner, runId) {
  const suffix = runId.replaceAll("-", "").slice(0, 10).toUpperCase();
  const institutionCode = `SMK${suffix}`;
  const departmentCode = `D${suffix}`;
  const updateEmployeeNo = `U${suffix}`;
  const skipEmployeeNo = `S${suffix}`;
  const insertEmployeeNo = `N${suffix}`;

  const institution = await owner.query(
    "insert into public.institutions (code, name, is_active) values ($1, $2, true) returning id",
    [institutionCode, `Smoke Institution ${suffix}`],
  );
  const department = await owner.query(
    "insert into public.departments (institution_id, code, name, is_active) values ($1::uuid, $2, $3, true) returning id",
    [institution.rows[0].id, departmentCode, `Smoke Department ${suffix}`],
  );
  await owner.query(
    `insert into public.employees (employee_no, name, institution_id, department_id, employment_status, job_title)
     values
       ($1, $2, $3::uuid, $4::uuid, 'ACTIVE', 'Before Update'),
       ($5, $6, $3::uuid, $4::uuid, 'ACTIVE', 'Keep Me')`,
    [
      updateEmployeeNo,
      `Smoke Update Before ${suffix}`,
      institution.rows[0].id,
      department.rows[0].id,
      skipEmployeeNo,
      `Smoke Skip ${suffix}`,
    ],
  );

  return { institutionCode, departmentCode, updateEmployeeNo, skipEmployeeNo, insertEmployeeNo };
}

async function createUploadedBatch(owner, actor, runId, suffix, rowCount, maxAttempts = 5) {
  return ownerTransactionAs(owner, actor.authUserId, async (client) => {
    const batch = await client.query(
      `insert into public.import_batches (
         batch_no, import_type, status, original_filename, expected_mime_type,
         expected_size_bytes, file_sha256, storage_object_key, upload_expires_at,
         mapping_version, upload_started_by, uploaded_at, uploaded_by, max_attempts
       ) values (
         $1, 'EMPLOYEES', 'UPLOADED', $2, 'text/csv', 1, $3,
         $4, now() + interval '1 hour', 'staging-active-smoke-v1', $5::uuid, now(), $5::uuid, $6
       ) returning *`,
      [
        `SMOKE-${runId}-${suffix}`,
        `${suffix.toLowerCase()}.csv`,
        "a".repeat(64),
        `staging-active-smoke/${runId}/${suffix}.csv`,
        actor.accountId,
        maxAttempts,
      ],
    );
    const chunk = await client.query(
      `insert into public.import_batch_chunks (
         batch_id, phase, chunk_no, start_row_number, end_row_number, idempotency_key
       ) values ($1::uuid, 'PARSE', 1, 1, $2::integer, $3)
       returning *`,
      [batch.rows[0].id, rowCount, `PARSE-${batch.rows[0].id}-1`],
    );
    return { batch: batch.rows[0], chunk: chunk.rows[0] };
  });
}

async function parseAndValidate(owner, worker, actor, runId, suffix, validationRows, maxAttempts = 5) {
  const fixture = await createUploadedBatch(owner, actor, runId, suffix, validationRows.length, maxAttempts);
  const parseClaim = await claimChunk(owner, worker, runId, fixture.batch.id, "PARSE", `${suffix}-parse-claim`);
  const parseRows = validationRows.map((row) => ({ row_number: row.row_number, raw_values: row.raw_values }));
  await completeChunk(owner, worker, runId, parseClaim, parseRows, `${suffix}-parse-complete`);

  const validateClaim = await claimChunk(owner, worker, runId, fixture.batch.id, "VALIDATE", `${suffix}-validate-claim`);
  await completeChunk(owner, worker, runId, validateClaim, validationRows, `${suffix}-validate-complete`);
  const batch = await owner.query("select * from public.import_batches where id = $1::uuid", [fixture.batch.id]);
  return batch.rows[0];
}

async function runLeaseAndRetrySmoke(owner, worker, actor, runId) {
  const fixture = await createUploadedBatch(owner, actor, runId, "LEASE", 1);
  const fingerprintValue = await claimChunkFingerprint(owner, fixture.batch.id, "PARSE", 60);
  const claimKey = `smoke-${runId}-lease-claim`;
  const first = await worker.query(
    "select * from public.claim_import_chunk($1::uuid, 'PARSE', 60, $2::text, $3::text)",
    [fixture.batch.id, claimKey, fingerprintValue],
  );
  const duplicate = await worker.query(
    "select * from public.claim_import_chunk($1::uuid, 'PARSE', 60, $2::text, $3::text)",
    [fixture.batch.id, claimKey, fingerprintValue],
  );
  assertCheck(
    "import-lease",
    "duplicate claim returns the same leased chunk",
    first.rows[0].id === duplicate.rows[0].id
      && first.rows[0].lease_token === duplicate.rows[0].lease_token
      && String(first.rows[0].lease_generation) === String(duplicate.rows[0].lease_generation),
  );

  await expectSqlState("import-fence", "wrong claim fingerprint is rejected", "40001", async () => {
    await worker.query(
      "select * from public.claim_import_chunk($1::uuid, 'PARSE', 60, $2::text, $3::text)",
      [fixture.batch.id, `smoke-${runId}-lease-wrong-fingerprint`, "0".repeat(64)],
    );
  });

  await ownerTransactionAs(owner, actor.authUserId, async (client) => {
    await client.query(
      "update public.import_batch_chunks set lease_expires_at = transaction_timestamp() - interval '1 second' where id = $1::uuid",
      [first.rows[0].id],
    );
  });
  const takeover = await claimChunk(owner, worker, runId, fixture.batch.id, "PARSE", "lease-takeover");
  assertCheck(
    "import-lease",
    "expired lease is taken over with a new generation and token",
    takeover.id === first.rows[0].id
      && Number(takeover.lease_generation) === Number(first.rows[0].lease_generation) + 1
      && takeover.lease_token !== first.rows[0].lease_token,
  );

  await expectSqlState("import-fence", "stale worker heartbeat is fenced after takeover", "40001", async () => {
    await worker.query(
      "select * from public.heartbeat_import_chunk($1::uuid, $2::text, $3::bigint, $4::bigint, 60)",
      [first.rows[0].id, first.rows[0].lease_token, first.rows[0].lease_generation, first.rows[0].cursor_version],
    );
  });

  const failureFixture = await createUploadedBatch(owner, actor, runId, "MAXFAIL", 1, 1);
  const failureClaim = await claimChunk(owner, worker, runId, failureFixture.batch.id, "PARSE", "maxfail-claim");
  const errorCode = "SMOKE_RETRYABLE";
  const errorMessage = "synthetic retry limit fixture";
  const failureFingerprint = await failChunkFingerprint(owner, failureClaim, errorCode, errorMessage, true);
  const failed = await worker.query(
    "select * from public.fail_import_chunk($1::uuid, $2::text, $3::bigint, $4::bigint, $5::text, $6::text, true, $7::text, $8::text)",
    [
      failureClaim.id,
      failureClaim.lease_token,
      failureClaim.lease_generation,
      failureClaim.cursor_version,
      errorCode,
      errorMessage,
      `smoke-${runId}-maxfail-fail`,
      failureFingerprint,
    ],
  );
  const failedBatch = await owner.query("select status from public.import_batches where id = $1::uuid", [failureFixture.batch.id]);
  assertCheck(
    "import-retry",
    "max-attempt retryable failure becomes terminal FAILED",
    failed.rows[0].status === "FAILED" && failedBatch.rows[0].status === "FAILED",
  );
}

async function runEmployeePreviewSmoke(owner, worker, actor, runId, master) {
  const rows = [
    {
      row_number: 1,
      raw_values: {
        employeeNo: master.insertEmployeeNo,
        name: "Smoke Insert Employee",
        institutionCode: master.institutionCode,
        departmentCode: master.departmentCode,
        employmentStatus: "ACTIVE",
        jobTitle: "Inserted",
      },
      normalized_values: {
        employeeNo: master.insertEmployeeNo,
        name: "Smoke Insert Employee",
        institutionCode: master.institutionCode,
        departmentCode: master.departmentCode,
        employmentStatus: "ACTIVE",
        jobTitle: "Inserted",
      },
      proposed_action: "INSERT",
      validation_errors: [],
      diffs: [],
    },
    {
      row_number: 2,
      raw_values: {
        employeeNo: master.updateEmployeeNo,
        name: "Smoke Update After",
        institutionCode: master.institutionCode,
        departmentCode: master.departmentCode,
        employmentStatus: "ACTIVE",
        jobTitle: "Updated",
      },
      normalized_values: {
        employeeNo: master.updateEmployeeNo,
        name: "Smoke Update After",
        institutionCode: master.institutionCode,
        departmentCode: master.departmentCode,
        employmentStatus: "ACTIVE",
        jobTitle: "Updated",
      },
      proposed_action: "UPDATE",
      validation_errors: [],
      diffs: [
        { field_name: "name", old_value: "Smoke Update Before", new_value: "Smoke Update After", confirmed: false },
      ],
    },
    {
      row_number: 3,
      raw_values: {
        employeeNo: master.skipEmployeeNo,
        name: "Smoke Skip",
        institutionCode: master.institutionCode,
        departmentCode: master.departmentCode,
        employmentStatus: "ACTIVE",
        jobTitle: "Keep Me",
      },
      normalized_values: {
        employeeNo: master.skipEmployeeNo,
        name: "Smoke Skip",
        institutionCode: master.institutionCode,
        departmentCode: master.departmentCode,
        employmentStatus: "ACTIVE",
        jobTitle: "Keep Me",
      },
      proposed_action: "SKIP",
      validation_errors: [],
      diffs: [],
    },
  ];

  const validated = await parseAndValidate(owner, worker, actor, runId, "EMPLOYEE", rows);
  assertCheck("import-preview", "EMPLOYEES INSERT/UPDATE/SKIP preview reaches VALIDATED", validated.status === "VALIDATED");
  await confirmBatch(owner, actor.authUserId, runId, validated.id, "employee-confirm");
  const confirmedDiffs = await owner.query(
    `select count(*)::integer as remaining
     from public.import_field_diffs d
     join public.import_rows r on r.id = d.import_row_id
     where r.batch_id = $1::uuid and not d.confirmed`,
    [validated.id],
  );
  assertCheck("import-confirm", "batch confirmation persists field-diff confirmation", confirmedDiffs.rows[0].remaining === 0);

  const applyLease = await claimApply(owner, worker, runId, validated.id, "employee-apply-claim");
  const applied = await applyBatch(owner, worker, runId, applyLease, "employee-apply");
  assertCheck("import-apply", "EMPLOYEES batch applies successfully", applied.status === "APPLIED");

  const employees = await owner.query(
    `select employee_no, name, job_title
     from public.employees
     where employee_no = any($1::text[])`,
    [[master.insertEmployeeNo, master.updateEmployeeNo, master.skipEmployeeNo]],
  );
  const byNo = new Map(employees.rows.map((row) => [row.employee_no, row]));
  assertCheck(
    "import-apply",
    "INSERT preview creates the synthetic employee",
    byNo.get(master.insertEmployeeNo)?.job_title === "Inserted",
  );
  assertCheck(
    "import-apply",
    "UPDATE preview changes the existing synthetic employee",
    byNo.get(master.updateEmployeeNo)?.name === "Smoke Update After" && byNo.get(master.updateEmployeeNo)?.job_title === "Updated",
  );
  assertCheck(
    "import-apply",
    "SKIP preview leaves the existing synthetic employee unchanged",
    byNo.get(master.skipEmployeeNo)?.job_title === "Keep Me",
  );

  const errorRows = [
    {
      row_number: 1,
      raw_values: {
        employeeNo: `E${runId.replaceAll("-", "").slice(0, 10).toUpperCase()}`,
        name: "Smoke Error Employee",
        institutionCode: master.institutionCode,
        departmentCode: master.departmentCode,
        employmentStatus: "ACTIVE",
      },
      normalized_values: null,
      proposed_action: "ERROR",
      validation_errors: [{ code: "SMOKE_EXPECTED", message: "synthetic validation error" }],
      diffs: [],
    },
  ];
  const errorBatch = await parseAndValidate(owner, worker, actor, runId, "ERROR", errorRows);
  assertCheck("import-preview", "ERROR preview makes the batch FAILED", errorBatch.status === "FAILED" && Number(errorBatch.error_row_count) === 1);
}

async function runZeroDiffConfirmationSmoke(owner, worker, actor, runId, master) {
  const rows = [
    {
      row_number: 1,
      raw_values: {
        employeeNo: master.skipEmployeeNo,
        name: "Smoke Skip",
        institutionCode: master.institutionCode,
        departmentCode: master.departmentCode,
        employmentStatus: "ACTIVE",
        jobTitle: "Keep Me",
      },
      normalized_values: {
        employeeNo: master.skipEmployeeNo,
        name: "Smoke Skip",
        institutionCode: master.institutionCode,
        departmentCode: master.departmentCode,
        employmentStatus: "ACTIVE",
        jobTitle: "Keep Me",
      },
      proposed_action: "SKIP",
      validation_errors: [],
      diffs: [],
    },
  ];
  const validated = await parseAndValidate(owner, worker, actor, runId, "ZERODIFF", rows);
  assertCheck("import-confirm", "zero-diff fixture reaches VALIDATED", validated.status === "VALIDATED");

  await expectSqlState("import-confirm", "zero-diff APPLY claim is blocked before user confirmation", "55000", async () => {
    await claimApply(owner, worker, runId, validated.id, "zerodiff-before-confirm");
  });

  const confirmed = await confirmBatch(owner, actor.authUserId, runId, validated.id, "zerodiff-confirm");
  assertCheck("import-confirm", "zero-diff confirmation persists confirmed_at/confirmed_by", confirmed.confirmed_at && confirmed.confirmed_by);
  const applyLease = await claimApply(owner, worker, runId, validated.id, "zerodiff-apply-claim");
  const applied = await applyBatch(owner, worker, runId, applyLease, "zerodiff-apply");
  assertCheck("import-confirm", "zero-diff batch applies only after confirmation", applied.status === "APPLIED");
}

async function createValidatedOpeningBatch(owner, actor, runId, suffix, warehouseCode, itemCode, quantity) {
  return ownerTransactionAs(owner, actor.authUserId, async (client) => {
    const batch = await client.query(
      `insert into public.import_batches (
         batch_no, import_type, status, original_filename, expected_mime_type,
         expected_size_bytes, file_sha256, storage_object_key, upload_expires_at,
         mapping_version, upload_started_by, uploaded_at, uploaded_by,
         validated_at, row_count, valid_row_count, error_row_count
       ) values (
         $1, 'OPENING_BALANCE', 'VALIDATED', $2, 'text/csv', 1, $3, $4,
         now() + interval '1 hour', 'staging-active-smoke-v1', $5::uuid, now(), $5::uuid,
         now(), 1, 1, 0
       ) returning *`,
      [
        `SMOKE-${runId}-${suffix}`,
        `${suffix.toLowerCase()}.csv`,
        "b".repeat(64),
        `staging-active-smoke/${runId}/${suffix}.csv`,
        actor.accountId,
      ],
    );
    await client.query(
      `insert into public.import_rows (
         batch_id, row_number, raw_values, normalized_values, proposed_action, validation_errors
       ) values ($1::uuid, 1, $2::jsonb, $2::jsonb, 'INSERT', '[]'::jsonb)`,
      [batch.rows[0].id, JSON.stringify({ warehouseCode, itemCode, quantity: String(quantity) })],
    );
    return batch.rows[0];
  });
}

async function runCutoverSmoke(owner, worker, actor, runId) {
  const warehouse = await owner.query(
    "select code from public.warehouses where is_active order by purpose, code limit 1",
  );
  assertCheck("cutover", "an active warehouse exists for the opening fixture", warehouse.rowCount === 1);

  const itemCode = `O${runId.replaceAll("-", "").slice(0, 12).toUpperCase()}`;
  const item = await owner.query(
    "insert into public.uniform_items (item_code, item_name, unit, is_active) values ($1, $2, 'PCS', true) returning id",
    [itemCode, `Opening Smoke ${itemCode}`],
  );
  const quantity = 7;
  const first = await createValidatedOpeningBatch(owner, actor, runId, "OPEN1", warehouse.rows[0].code, itemCode, quantity);
  await confirmBatch(owner, actor.authUserId, runId, first.id, "open1-confirm");
  const firstLease = await claimApply(owner, worker, runId, first.id, "open1-claim");
  const firstApplied = await applyBatch(owner, worker, runId, firstLease, "open1-apply");
  assertCheck("cutover", "first opening balance applies successfully", firstApplied.status === "APPLIED");

  const state = await owner.query(
    "select status, opening_import_batch_id, opening_posting_id from public.system_cutover_state where id = 1",
  );
  assertCheck(
    "cutover",
    "first opening balance performs the once-only LIVE transition",
    state.rows[0].status === "LIVE"
      && state.rows[0].opening_import_batch_id === first.id
      && state.rows[0].opening_posting_id,
  );
  const balance = await owner.query(
    `select b.on_hand_quantity
     from public.inventory_balances b
     join public.warehouses w on w.id = b.warehouse_id
     where w.code = $1 and b.item_id = $2::uuid`,
    [warehouse.rows[0].code, item.rows[0].id],
  );
  assertCheck("cutover", "opening balance creates the expected inventory quantity", Number(balance.rows[0]?.on_hand_quantity) === quantity);

  const second = await createValidatedOpeningBatch(owner, actor, runId, "OPEN2", warehouse.rows[0].code, itemCode, quantity);
  await confirmBatch(owner, actor.authUserId, runId, second.id, "open2-confirm");
  const secondLease = await claimApply(owner, worker, runId, second.id, "open2-claim");
  await expectSqlState("cutover", "second opening balance is rejected after LIVE", "55000", async () => {
    await applyBatch(owner, worker, runId, secondLease, "open2-apply");
  });
}

function printSummary() {
  const failures = checks.filter((check) => !check.ok);
  console.log(`Summary: ${checks.length - failures.length} passed, ${failures.length} failed.`);
  console.log("No database URL, password, token, or secret value was printed.");
  console.log("This command intentionally leaves synthetic rows and append-only audit evidence. Use it only on a disposable staging generation.");
  if (runCutover) {
    console.log("Cutover scope permanently changes a successful PRE_CUTOVER fixture to LIVE. Never reset it back manually; create a fresh staging generation to rerun.");
  }
  if (failures.length > 0) process.exitCode = 1;
}

async function main() {
  const config = readConfig();
  const owner = new Client({ connectionString: config.maintenanceUrl, application_name: "uniform-staging-active-smoke-owner" });
  const worker = new Client({ connectionString: config.importWorkerUrl, application_name: "uniform-staging-active-smoke-import-worker" });
  const runId = randomUUID();

  try {
    await owner.connect();
    await worker.connect();

    const identities = await Promise.all([
      owner.query("select session_user, current_setting('transaction_read_only') as transaction_read_only"),
      worker.query("select session_user, current_setting('transaction_read_only') as transaction_read_only"),
    ]);
    assertCheck("connection", "maintenance connection is writable", identities[0].rows[0].transaction_read_only === "off");
    assertCheck("connection", "import worker connection uses session_user=job_import_worker", identities[1].rows[0].session_user === "job_import_worker");
    assertCheck("connection", "import worker connection is writable", identities[1].rows[0].transaction_read_only === "off");

    const state = await owner.query(
      "select status, opening_import_batch_id, opening_posting_id from public.system_cutover_state where id = 1",
    );
    assertCheck(
      "baseline",
      "disposable staging starts from a clean PRE_CUTOVER singleton",
      state.rowCount === 1
        && state.rows[0].status === "PRE_CUTOVER"
        && state.rows[0].opening_import_batch_id === null
        && state.rows[0].opening_posting_id === null,
    );

    const workerBinding = await owner.query(
      `select b.is_active as binding_active, a.is_active as account_active,
              coalesce(array_agg(ur.role_code::text order by ur.role_code::text)
                filter (where ur.role_code is not null), array[]::text[]) as roles
       from private.job_actor_bindings b
       join public.app_accounts a on a.id = b.account_id
       left join public.user_roles ur on ur.account_id = a.id
       where b.db_role = 'job_import_worker'::name
       group by b.is_active, a.is_active`,
    );
    assertCheck(
      "worker-binding",
      "job_import_worker has an active audit actor binding",
      workerBinding.rowCount === 1 && workerBinding.rows[0].binding_active && workerBinding.rows[0].account_active,
    );
    const workerRoles = new Set(workerBinding.rows[0].roles);
    if (runImport) {
      assertCheck("worker-binding", "job_import_worker audit actor has HR for EMPLOYEES APPLY", workerRoles.has("HR"));
    }
    if (runCutover) {
      assertCheck("worker-binding", "job_import_worker audit actor has SYSTEM_ADMIN for opening APPLY", workerRoles.has("SYSTEM_ADMIN"));
      const postingCount = await owner.query("select count(*)::integer as count from public.inventory_postings");
      assertCheck("cutover", "opening fixture starts before any inventory posting", postingCount.rows[0].count === 0);
    }

    const actor = await createSyntheticActor(owner, runId);
    await authenticatedTransaction(owner, actor.authUserId, async (client) => {
      const auth = await client.query("select auth.uid()::text as uid, auth.jwt() ->> 'role' as role");
      assertCheck(
        "auth-simulation",
        "direct DB authenticated claims resolve the synthetic staging account",
        auth.rows[0].uid === actor.authUserId && auth.rows[0].role === "authenticated",
      );
    });

    if (runImport) {
      const master = await createMasterFixture(owner, runId);
      await runLeaseAndRetrySmoke(owner, worker, actor, runId);
      await runEmployeePreviewSmoke(owner, worker, actor, runId, master);
      await runZeroDiffConfirmationSmoke(owner, worker, actor, runId, master);
    }

    if (runCutover) {
      await runCutoverSmoke(owner, worker, actor, runId);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record("runtime", "active staging smoke completed", false, message);
  } finally {
    await Promise.all([owner.end().catch(() => {}), worker.end().catch(() => {})]);
  }

  printSummary();
}

await main();
