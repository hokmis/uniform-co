import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");
const workerScript = resolve(repoRoot, "scripts/renderer/renderer-worker.mjs");
const storageProxyScript = resolve(repoRoot, "scripts/renderer/storage-proxy.mjs");
const pdfAdapter = resolve(repoRoot, "scripts/renderer/adapters/uniform-pdf-smoke-v0.mjs");
const erpAdapter = resolve(repoRoot, "scripts/renderer/adapters/uniform-erp-sales-v0.mjs");

const requiredGates = new Map([
  ["UNIFORM_DEPLOYMENT_ENV", "staging"],
  ["UNIFORM_STAGING_SMOKE_CONFIRM", "YES"],
  ["UNIFORM_STAGING_ACTIVE_SMOKE_CONFIRM", "DISPOSABLE_STAGING_ONLY"],
  ["UNIFORM_STAGING_RENDERER_SMOKE_CONFIRM", "RENDERER_STORAGE_WRITE_OK"],
]);
const requiredConfig = [
  "STAGING_DATABASE_URL",
  "DOCUMENT_RENDERER_DATABASE_URL",
  "ERP_RENDERER_DATABASE_URL",
  "RENDER_STORAGE_PROXY_DATABASE_URL",
  "SUPABASE_URL",
  "SUPABASE_STORAGE_ADMIN_KEY",
];

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const asText = (value) => String(value ?? "");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function validatePostgresUrl(name, value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid PostgreSQL URL`);
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || !parsed.username) {
    throw new Error(`${name} must be a PostgreSQL connection URL`);
  }
}

function validateHttpsUrl(name, value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTPS URL`);
  }
  if (parsed.protocol !== "https:" || !parsed.hostname) throw new Error(`${name} must be an HTTPS URL`);
}

// Fail closed before constructing a DB client, opening a socket, or starting a child process.
for (const [name, expected] of requiredGates) {
  if (process.env[name] !== expected) throw new Error(`${name} must equal ${expected}`);
}
for (const name of requiredConfig) {
  if (!process.env[name]?.trim()) throw new Error(`${name} is required`);
}
for (const name of [
  "STAGING_DATABASE_URL",
  "DOCUMENT_RENDERER_DATABASE_URL",
  "ERP_RENDERER_DATABASE_URL",
  "RENDER_STORAGE_PROXY_DATABASE_URL",
]) {
  validatePostgresUrl(name, process.env[name]);
}
validateHttpsUrl("SUPABASE_URL", process.env.SUPABASE_URL);

const storageProxyToken = randomBytes(32).toString("hex");
const runId = randomUUID();
const runTag = runId.replaceAll("-", "").slice(0, 12);
const fixturePrefix = `staging-renderer-smoke-${runTag}`;

async function connectProtected(connectionString, label) {
  const client = new Client({ connectionString, application_name: `uniform-${fixturePrefix}-${label}` });
  try {
    await client.connect();
    return client;
  } catch {
    await client.end().catch(() => undefined);
    throw new Error(`Could not connect to protected ${label} database`);
  }
}

async function assertSessionUser(client, expected) {
  const result = await client.query("select session_user::text as session_user");
  assert(result.rows[0]?.session_user === expected, `Protected connection must use session_user=${expected}`);
}

async function expectSqlState(operation, expectedCode, label) {
  try {
    await operation();
  } catch (error) {
    if (expectedCode && error?.code !== expectedCode) {
      throw new Error(`${label} returned SQLSTATE ${error?.code ?? "unknown"}, expected ${expectedCode}`);
    }
    return;
  }
  throw new Error(`${label} unexpectedly succeeded`);
}

async function withActor(client, actor, operation) {
  await client.query("begin");
  try {
    const claims = JSON.stringify({ sub: actor.authUserId, role: "authenticated" });
    await client.query(
      "select set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claim.role','authenticated',true), set_config('request.jwt.claims',$2,true)",
      [actor.authUserId, claims],
    );
    await client.query("set local role authenticated");
    const result = await operation(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  }
}

async function setMaintenanceActor(client, actor) {
  const claims = JSON.stringify({ sub: actor.authUserId, role: "authenticated" });
  await client.query(
    "select set_config('request.jwt.claim.sub',$1,false), set_config('request.jwt.claim.role','authenticated',false), set_config('request.jwt.claims',$2,false)",
    [actor.authUserId, claims],
  );
}

async function createActor(client, role, suffix) {
  const authUserId = randomUUID();
  const login = `smk${role.toLowerCase()}${suffix}`.replaceAll(/[^a-z0-9]/g, "").slice(0, 50);
  const account = await client.query(
    `insert into public.app_accounts(auth_user_id, login_name, display_name, email_snapshot, is_active)
     values ($1,$2,$3,null,true)
     returning id`,
    [authUserId, login, `${fixturePrefix} ${role}`],
  );
  await client.query("insert into public.user_roles(account_id, role_code) values ($1,$2::public.app_role)", [account.rows[0].id, role]);
  return { id: account.rows[0].id, authUserId, role };
}

async function assertNoExistingPreparingWork(client) {
  const result = await client.query(`
    select
      (select count(*)::int from public.document_artifacts where status='PREPARING') as document_count,
      (select count(*)::int from public.erp_export_artifacts where status='PREPARING') as erp_count
  `);
  const row = result.rows[0];
  assert(row.document_count === 0, "Disposable staging contains pre-existing PREPARING PDF work; refusing to claim unrelated work");
  assert(row.erp_count === 0, "Disposable staging contains pre-existing PREPARING ERP work; refusing to claim unrelated work");
}

async function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

async function waitForPort(port, child, label) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} exited before becoming ready`);
    const opened = await new Promise((resolveOpened) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolveOpened(true); });
      socket.once("error", () => resolveOpened(false));
      socket.setTimeout(250, () => { socket.destroy(); resolveOpened(false); });
    });
    if (opened) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`${label} did not become ready`);
}

function captureChild(child) {
  let output = "";
  const append = (chunk) => {
    output = `${output}${chunk.toString("utf8")}`.slice(-20_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return () => output;
}

function startStorageProxy(port) {
  const child = spawn(process.execPath, [storageProxyScript], {
    cwd: repoRoot,
    env: {
      ...process.env,
      RENDER_STORAGE_PROXY_PORT: String(port),
      RENDER_STORAGE_PROXY_TOKEN: storageProxyToken,
      RENDER_STORAGE_PROXY_DATABASE_URL: process.env.RENDER_STORAGE_PROXY_DATABASE_URL,
      SUPABASE_URL: process.env.SUPABASE_URL,
      SUPABASE_STORAGE_ADMIN_KEY: process.env.SUPABASE_STORAGE_ADMIN_KEY,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { child, output: captureChild(child) };
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await new Promise((resolveExit) => {
    const timer = setTimeout(resolveExit, 2_000);
    child.once("exit", () => { clearTimeout(timer); resolveExit(); });
  });
  if (child.exitCode === null) child.kill("SIGKILL");
}

async function runWorker({ kind, databaseUrl, proxyUrl, adapter, adapterArgs = [], expectSuccess = true }) {
  const child = spawn(process.execPath, [workerScript, `--kind=${kind}`], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      RENDER_STORAGE_PROXY_URL: proxyUrl,
      RENDER_STORAGE_PROXY_TOKEN: storageProxyToken,
      RENDER_COMMAND: process.execPath,
      RENDER_COMMAND_ARGS: JSON.stringify([adapter, ...adapterArgs]),
      RENDER_LEASE_SECONDS: "120",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const readOutput = captureChild(child);
  const exitCode = await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${kind} renderer worker timed out`));
    }, 30_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); resolveExit(code ?? 1); });
  });
  if (expectSuccess && exitCode !== 0) throw new Error(`${kind} renderer worker failed (output withheld; ${readOutput().length} bytes captured)`);
  if (!expectSuccess && exitCode === 0) throw new Error(`${kind} renderer worker unexpectedly succeeded`);
}

async function startLossyProxy(upstreamPort) {
  let droppedUploadResponse = false;
  const server = http.createServer((request, response) => {
    const upstream = http.request({
      hostname: "127.0.0.1",
      port: upstreamPort,
      path: request.url,
      method: request.method,
      headers: request.headers,
    }, (upstreamResponse) => {
      const chunks = [];
      upstreamResponse.on("data", (chunk) => chunks.push(chunk));
      upstreamResponse.on("end", () => {
        const body = Buffer.concat(chunks);
        const isFirstSuccessfulUpload = !droppedUploadResponse
          && request.url?.startsWith("/upload/")
          && (upstreamResponse.statusCode ?? 500) >= 200
          && (upstreamResponse.statusCode ?? 500) < 300;
        if (isFirstSuccessfulUpload) {
          droppedUploadResponse = true;
          response.socket?.destroy();
          return;
        }
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        response.end(body);
      });
    });
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  assert(Number.isInteger(port), "Could not allocate lossy proxy port");
  return {
    url: `http://127.0.0.1:${port}`,
    didDropUploadResponse: () => droppedUploadResponse,
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
  };
}

async function fetchStorageObject(bucket, objectKey) {
  const base = process.env.SUPABASE_URL.replace(/\/$/, "");
  const encodedKey = objectKey.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(`${base}/storage/v1/object/${encodeURIComponent(bucket)}/${encodedKey}`, {
    headers: {
      authorization: `Bearer ${process.env.SUPABASE_STORAGE_ADMIN_KEY}`,
      apikey: process.env.SUPABASE_STORAGE_ADMIN_KEY,
    },
  });
  assert(response.ok, `Storage-admin byte verification failed for ${bucket}`);
  return Buffer.from(await response.arrayBuffer());
}

async function verifyStorageBytes(bucket, artifact) {
  const bytes = await fetchStorageObject(bucket, artifact.storage_object_key);
  assert(bytes.length === Number(artifact.payload_size_bytes), `${bucket} byte size does not match artifact metadata`);
  assert(sha256(bytes) === artifact.payload_sha256, `${bucket} SHA-256 does not match artifact metadata`);
}

async function requestStocktakePdf(client, actor, stocktakeId, sequence, advisoryHash) {
  const fingerprint = JSON.stringify({
    documentType: "STOCKTAKE",
    documentId: stocktakeId,
    artifactKind: "DRAFT_WATERMARK",
    version: 1,
    hash: advisoryHash,
  });
  const result = await withActor(client, actor, (db) => db.query(
    `select (public.request_document_pdf($1,$2,$3,$4,$5,$6,$7,$8)).*`,
    [
      "STOCKTAKE",
      stocktakeId,
      "staging-renderer-smoke-v1",
      1,
      advisoryHash,
      `${fixturePrefix}:pdf:${sequence}:${actor.role}`,
      fingerprint,
      "DRAFT_WATERMARK",
    ],
  ));
  return result.rows[0];
}

async function expectStocktakeRequestDenied(client, actor, stocktakeId, sequence) {
  const advisoryHash = `${fixturePrefix}-denied-${sequence}`;
  await expectSqlState(
    () => requestStocktakePdf(client, actor, stocktakeId, `denied-${sequence}`, advisoryHash),
    "42501",
    `${actor.role} STOCKTAKE PDF request`,
  );
}

async function requestErpArtifact(client, actor, batchId, sequence) {
  const fingerprint = JSON.stringify({
    batchId,
    formatVersion: "UNIFORM-ERP-SALES-v0",
    sourceSnapshotVersion: 1,
    sourceSnapshotHash: "d41d8cd98f00b204e9800998ecf8427e",
  });
  const result = await withActor(client, actor, (db) => db.query(
    "select (public.request_erp_artifact($1,$2,$3,$4)).*",
    [batchId, "UNIFORM-ERP-SALES-v0", `${fixturePrefix}:erp:${sequence}`, fingerprint],
  ));
  return result.rows[0];
}

async function createErpBatch(client, actor, fixture, sequence) {
  const batch = await client.query(
    `insert into public.erp_export_batches(
       batch_no, export_kind, distribution_date,
       institution_id_snapshot, institution_code_snapshot, institution_name_snapshot,
       status, source_snapshot_version, source_snapshot_hash, prepared_by
     ) values ($1,'SALES',current_date,$2,$3,$4,'PREPARING',1,$5,$6)
     returning id`,
    [
      `${fixturePrefix}-ERP-${sequence}`,
      fixture.institutionId,
      fixture.institutionCode,
      fixture.institutionName,
      "d41d8cd98f00b204e9800998ecf8427e",
      actor.id,
    ],
  );
  await client.query(
    `insert into public.erp_export_batch_lines(
       batch_id,line_no,item_id,item_code_snapshot,item_name_snapshot,unit_snapshot,quantity
     ) values ($1,1,$2,$3,$4,$5,1)`,
    [batch.rows[0].id, fixture.itemId, fixture.itemCode, fixture.itemName, fixture.unit],
  );
  return batch.rows[0].id;
}

let maintenance;
let documentRenderer;
let erpRenderer;
let proxyDatabase;
let storageProxy;
let lossyProxy;

try {
  maintenance = await connectProtected(process.env.STAGING_DATABASE_URL, "maintenance");
  documentRenderer = await connectProtected(process.env.DOCUMENT_RENDERER_DATABASE_URL, "document-renderer");
  erpRenderer = await connectProtected(process.env.ERP_RENDERER_DATABASE_URL, "erp-renderer");
  proxyDatabase = await connectProtected(process.env.RENDER_STORAGE_PROXY_DATABASE_URL, "renderer-storage-proxy");

  await assertSessionUser(documentRenderer, "job_document_renderer");
  await assertSessionUser(erpRenderer, "job_erp_renderer");
  await assertSessionUser(proxyDatabase, "job_renderer_storage_proxy");

  const bindings = await maintenance.query(`
    select b.db_role::text as db_role, b.is_active, a.is_active as account_active
    from private.job_actor_bindings b
    join public.app_accounts a on a.id=b.account_id
    where b.db_role in ('job_document_renderer','job_erp_renderer','job_renderer_storage_proxy')
  `);
  const bindingByRole = new Map(bindings.rows.map((row) => [row.db_role, row]));
  for (const role of ["job_document_renderer", "job_erp_renderer", "job_renderer_storage_proxy"]) {
    const binding = bindingByRole.get(role);
    assert(binding?.is_active === true && binding?.account_active === true, `${role} must have an active job actor binding`);
  }

  await assertNoExistingPreparingWork(maintenance);

  const actors = {};
  for (const role of ["HR", "WAREHOUSE", "PROCUREMENT", "CEO"]) {
    actors[role] = await createActor(maintenance, role, runTag.slice(0, 8));
  }
  await setMaintenanceActor(maintenance, actors.HR);

  const warehouse = await maintenance.query("select id from public.warehouses where is_active order by purpose, id limit 1");
  assert(warehouse.rows[0]?.id, "At least one active staging warehouse is required");

  const itemCode = `SMK${runTag.toUpperCase()}`;
  const itemName = `${fixturePrefix} item`;
  const item = await maintenance.query(
    "insert into public.uniform_items(item_code,item_name,unit,is_active) values ($1,$2,'PCS',true) returning id,item_code,item_name,unit",
    [itemCode, itemName],
  );
  const institutionCode = `S${runTag.toUpperCase().slice(0, 10)}`;
  const institutionName = `${fixturePrefix} institution`;
  const institution = await maintenance.query(
    "insert into public.institutions(code,name,is_active) values ($1,$2,true) returning id,code,name",
    [institutionCode, institutionName],
  );
  const stocktake = await maintenance.query(
    `insert into public.stocktakes(stocktake_no,warehouse_id,status,created_by,note)
     values ($1,$2,'DRAFT',$3,$4) returning id`,
    [`${fixturePrefix}-ST`, warehouse.rows[0].id, actors.HR.id, `${fixturePrefix} revision 1`],
  );
  await maintenance.query(
    `insert into public.stocktake_lines(
       stocktake_id,item_id,book_quantity_snapshot,balance_version_snapshot,counted_quantity
     ) values ($1,$2,0,0,0)`,
    [stocktake.rows[0].id, item.rows[0].id],
  );
  const fixture = {
    stocktakeId: stocktake.rows[0].id,
    itemId: item.rows[0].id,
    itemCode: item.rows[0].item_code,
    itemName: item.rows[0].item_name,
    unit: item.rows[0].unit,
    institutionId: institution.rows[0].id,
    institutionCode: institution.rows[0].code,
    institutionName: institution.rows[0].name,
  };

  const storageProxyPort = await getFreePort();
  storageProxy = startStorageProxy(storageProxyPort);
  await waitForPort(storageProxyPort, storageProxy.child, "renderer storage proxy");
  const storageProxyUrl = `http://127.0.0.1:${storageProxyPort}`;

  console.log("[1/7] protected renderer/proxy LOGIN identities and bindings: PASS");

  const pdfRevision1 = await requestStocktakePdf(
    maintenance,
    actors.HR,
    fixture.stocktakeId,
    "revision-1",
    `${fixturePrefix}-advisory-r1`,
  );
  await expectStocktakeRequestDenied(maintenance, actors.PROCUREMENT, fixture.stocktakeId, "procurement");
  await expectStocktakeRequestDenied(maintenance, actors.CEO, fixture.stocktakeId, "ceo");

  const firstClaim = (await documentRenderer.query("select * from public.claim_document_render_attempt($1)", [120])).rows[0];
  assert(firstClaim?.artifact_id === pdfRevision1.id, "Document renderer claimed work outside the synthetic fixture");
  const firstGeneration = Number(firstClaim.lease_generation);
  const firstToken = firstClaim.lease_token;
  const firstKey = firstClaim.temp_object_key;
  assert(firstGeneration >= 1 && firstToken && firstKey, "Initial PDF claim did not return a complete lease");

  const oldCapabilityBeforeExpiry = await proxyDatabase.query(
    "select private.renderer_storage_capability($1,$2,$3,$4,$5) as allowed",
    ["uniform-pdf", firstKey, firstClaim.id, firstToken, firstGeneration],
  );
  assert(oldCapabilityBeforeExpiry.rows[0]?.allowed === true, "Current PDF lease did not authorize its exact Storage key");

  await maintenance.query(
    "update public.document_render_attempts set lease_expires_at=transaction_timestamp()-interval '1 second' where id=$1 and lease_generation=$2",
    [firstClaim.id, firstGeneration],
  );
  const secondClaim = (await documentRenderer.query("select * from public.claim_document_render_attempt($1)", [120])).rows[0];
  assert(secondClaim?.id === firstClaim.id, "Expired PDF lease takeover did not reuse the same attempt");
  assert(Number(secondClaim.lease_generation) === firstGeneration + 1, "PDF lease generation did not increment on takeover");
  assert(secondClaim.lease_token !== firstToken, "PDF takeover reused the stale lease token");
  assert(secondClaim.temp_object_key !== firstKey, "PDF takeover reused the stale generation object key");

  await expectSqlState(
    () => documentRenderer.query("select public.heartbeat_document_render_attempt($1,$2,$3,$4)", [firstClaim.id, firstToken, firstGeneration, 120]),
    "40001",
    "stale PDF heartbeat",
  );
  await expectSqlState(
    () => documentRenderer.query("select public.get_document_render_payload($1,$2,$3)", [firstClaim.id, firstToken, firstGeneration]),
    null,
    "stale PDF payload read",
  );
  await expectSqlState(
    () => documentRenderer.query(
      "select public.finalize_document_render_attempt($1,$2,$3,$4,$5,$6)",
      [firstClaim.id, firstToken, firstGeneration, firstKey, "0".repeat(64), 1],
    ),
    "40001",
    "stale PDF finalize",
  );
  const oldCapability = await proxyDatabase.query(
    "select private.renderer_storage_capability($1,$2,$3,$4,$5) as allowed",
    ["uniform-pdf", firstKey, firstClaim.id, firstToken, firstGeneration],
  );
  const newCapability = await proxyDatabase.query(
    "select private.renderer_storage_capability($1,$2,$3,$4,$5) as allowed",
    ["uniform-pdf", secondClaim.temp_object_key, secondClaim.id, secondClaim.lease_token, secondClaim.lease_generation],
  );
  assert(oldCapability.rows[0]?.allowed === false, "Expired PDF generation still has Storage capability");
  assert(newCapability.rows[0]?.allowed === true, "Current PDF generation lacks exact Storage capability");

  await maintenance.query(
    "update public.document_render_attempts set lease_expires_at=transaction_timestamp()-interval '1 second' where id=$1 and lease_generation=$2",
    [secondClaim.id, secondClaim.lease_generation],
  );
  await runWorker({
    kind: "PDF",
    databaseUrl: process.env.DOCUMENT_RENDERER_DATABASE_URL,
    proxyUrl: storageProxyUrl,
    adapter: pdfAdapter,
  });
  const pdf1Ready = (await maintenance.query(
    "select * from public.document_artifacts where id=$1",
    [pdfRevision1.id],
  )).rows[0];
  assert(pdf1Ready?.status === "READY" && pdf1Ready.is_current === true, "PDF revision 1 did not finalize READY/current");
  await verifyStorageBytes("uniform-pdf", pdf1Ready);
  console.log("[2/7] PDF claim/generation fence/proxy upload/finalize + Storage bytes: PASS");

  await maintenance.query("update public.stocktakes set note=$2 where id=$1", [fixture.stocktakeId, `${fixturePrefix} revision 2`]);
  const pdfRevision2 = await requestStocktakePdf(
    maintenance,
    actors.WAREHOUSE,
    fixture.stocktakeId,
    "revision-2",
    `${fixturePrefix}-advisory-r2`,
  );
  await runWorker({
    kind: "PDF",
    databaseUrl: process.env.DOCUMENT_RENDERER_DATABASE_URL,
    proxyUrl: storageProxyUrl,
    adapter: pdfAdapter,
  });

  const pdfHistory = await maintenance.query(
    `select a.id,a.revision,a.status,a.is_current,a.supersedes_artifact_id,f.current_artifact_id,
            a.storage_object_key,a.payload_sha256,a.payload_size_bytes
     from public.document_artifacts a join public.document_artifact_families f on f.id=a.family_id
     where a.id in ($1,$2) order by a.revision`,
    [pdfRevision1.id, pdfRevision2.id],
  );
  const [history1, history2] = pdfHistory.rows;
  assert(history1?.status === "READY" && history1.is_current === false, "PDF revision 1 history was not retained as READY/non-current");
  assert(history2?.status === "READY" && history2.is_current === true, "PDF revision 2 did not become READY/current");
  assert(history2.supersedes_artifact_id === history1.id, "PDF revision 2 does not supersede revision 1");
  assert(history2.current_artifact_id === history2.id, "Document family current_artifact_id does not point to revision 2");
  await verifyStorageBytes("uniform-pdf", history2);

  for (const actor of [actors.HR, actors.WAREHOUSE]) {
    const download = await withActor(maintenance, actor, (db) => db.query("select public.download_document($1) as grant", [history2.id]));
    assert(download.rows[0]?.grant?.object_key === history2.storage_object_key, `${actor.role} did not receive the expected document grant`);
  }
  for (const actor of [actors.PROCUREMENT, actors.CEO]) {
    await expectSqlState(
      () => withActor(maintenance, actor, (db) => db.query("select public.download_document($1)", [history2.id])),
      "42501",
      `${actor.role} STOCKTAKE download`,
    );
  }
  console.log("[3/7] PDF historical READY revision + HR/WAREHOUSE allow, PROCUREMENT/CEO deny: PASS");

  const erpBatch1 = await createErpBatch(maintenance, actors.HR, fixture, "retry-success");
  const erpArtifact1 = await requestErpArtifact(maintenance, actors.HR, erpBatch1, "retry-success");
  await maintenance.query("update public.erp_export_artifacts set max_attempts=2 where id=$1", [erpArtifact1.id]);
  await runWorker({
    kind: "ERP",
    databaseUrl: process.env.ERP_RENDERER_DATABASE_URL,
    proxyUrl: storageProxyUrl,
    adapter: pdfAdapter,
    adapterArgs: ["--mode", "fail"],
    expectSuccess: false,
  });
  const retryState = await maintenance.query(
    `select a.status as artifact_status,
            count(*) filter (where r.attempt_no=1 and r.status='FAILED')::int as failed_first,
            count(*) filter (where r.attempt_no=2 and r.status='PENDING')::int as pending_second
     from public.erp_export_artifacts a
     join public.erp_export_render_attempts r on r.artifact_id=a.id
     where a.id=$1 group by a.status`,
    [erpArtifact1.id],
  );
  assert(retryState.rows[0]?.artifact_status === "PREPARING", "ERP retry artifact did not remain PREPARING after first failure");
  assert(retryState.rows[0]?.failed_first === 1 && retryState.rows[0]?.pending_second === 1, "ERP retry did not create FAILED attempt 1 + PENDING attempt 2");

  lossyProxy = await startLossyProxy(storageProxyPort);
  await runWorker({
    kind: "ERP",
    databaseUrl: process.env.ERP_RENDERER_DATABASE_URL,
    proxyUrl: lossyProxy.url,
    adapter: erpAdapter,
  });
  assert(lossyProxy.didDropUploadResponse(), "Lossy proxy did not drop the first successful ERP upload response");
  await lossyProxy.close();
  lossyProxy = null;

  const erpReady = (await maintenance.query(
    `select a.*,b.status as batch_status
     from public.erp_export_artifacts a join public.erp_export_batches b on b.id=a.batch_id
     where a.id=$1`,
    [erpArtifact1.id],
  )).rows[0];
  assert(erpReady?.status === "READY" && erpReady.batch_status === "GENERATED", "ERP retry-success did not finalize artifact READY and batch GENERATED");
  await verifyStorageBytes("uniform-erp", erpReady);
  console.log("[4/7] ERP retry then success + upload response-loss recovery + Storage bytes: PASS");

  const erpBatch2 = await createErpBatch(maintenance, actors.HR, fixture, "terminal-failure");
  const erpArtifact2 = await requestErpArtifact(maintenance, actors.HR, erpBatch2, "terminal-failure");
  await maintenance.query("update public.erp_export_artifacts set max_attempts=1 where id=$1", [erpArtifact2.id]);
  await runWorker({
    kind: "ERP",
    databaseUrl: process.env.ERP_RENDERER_DATABASE_URL,
    proxyUrl: storageProxyUrl,
    adapter: pdfAdapter,
    adapterArgs: ["--mode", "fail"],
    expectSuccess: false,
  });
  const terminalState = await maintenance.query(
    `select a.status as artifact_status,b.status as batch_status,
            count(*) filter (where r.status='FAILED')::int as failed_attempts,
            count(*) filter (where r.status='PENDING')::int as pending_attempts
     from public.erp_export_artifacts a
     join public.erp_export_batches b on b.id=a.batch_id
     join public.erp_export_render_attempts r on r.artifact_id=a.id
     where a.id=$1 group by a.status,b.status`,
    [erpArtifact2.id],
  );
  assert(terminalState.rows[0]?.artifact_status === "FAILED", "ERP max_attempts=1 artifact did not become FAILED");
  assert(terminalState.rows[0]?.batch_status === "GENERATION_FAILED", "ERP max_attempts=1 batch did not become GENERATION_FAILED");
  assert(terminalState.rows[0]?.failed_attempts === 1 && terminalState.rows[0]?.pending_attempts === 0, "ERP terminal failure retained unexpected PENDING work");
  console.log("[5/7] ERP terminal failure/max-attempt fence: PASS");

  const remaining = await maintenance.query(`
    select
      (select count(*)::int from public.document_artifacts where status='PREPARING') as document_count,
      (select count(*)::int from public.erp_export_artifacts where status='PREPARING') as erp_count
  `);
  assert(remaining.rows[0]?.document_count === 0 && remaining.rows[0]?.erp_count === 0, "Synthetic renderer smoke left PREPARING work behind");
  console.log("[6/7] synthetic renderer queues drained without deleting READY/audit evidence: PASS");
  console.log("[7/7] renderer/storage active smoke: PASS");
  console.log(`Synthetic evidence prefix: ${fixturePrefix}`);
} finally {
  if (lossyProxy) await lossyProxy.close().catch(() => undefined);
  await stopChild(storageProxy?.child);
  await proxyDatabase?.end().catch(() => undefined);
  await erpRenderer?.end().catch(() => undefined);
  await documentRenderer?.end().catch(() => undefined);
  await maintenance?.end().catch(() => undefined);
}
