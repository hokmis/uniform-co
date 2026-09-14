#!/usr/bin/env node
import { createServer } from "node:http";
import { Client } from "pg";

const port = Number(process.env.RENDER_STORAGE_PROXY_PORT ?? 8787);
const proxyToken = process.env.RENDER_STORAGE_PROXY_TOKEN;
const dbUrl = process.env.RENDER_STORAGE_PROXY_DATABASE_URL;
const storageUrl = process.env.SUPABASE_URL;
const storageKey = process.env.SUPABASE_STORAGE_ADMIN_KEY;
const maxBytes = 20_000_000;
if (!Number.isInteger(port) || port < 1 || port > 65535 || !proxyToken || !dbUrl || !storageUrl || !storageKey) {
  throw new Error("RENDER_STORAGE_PROXY_PORT, RENDER_STORAGE_PROXY_TOKEN, RENDER_STORAGE_PROXY_DATABASE_URL, SUPABASE_URL and SUPABASE_STORAGE_ADMIN_KEY are required");
}

const db = new Client({ connectionString: dbUrl, application_name: "uniform-render-storage-proxy" });
await db.connect();
const storageBase = storageUrl.replace(/\/$/, "");
const authHeaders = { authorization: `Bearer ${storageKey}`, apikey: storageKey };

function parseObjectPath(urlPath) {
  const match = urlPath.match(/^\/(upload|info|download)\/([^/]+)\/(.+)$/);
  if (!match) return null;
  const bucket = decodeURIComponent(match[2]);
  const key = match[3].split("/").map(decodeURIComponent).join("/");
  if (!["uniform-pdf", "uniform-erp", "uniform-imports"].includes(bucket) || !key || key.includes("..") || key.startsWith("/")) return null;
  return { operation: match[1], bucket, key };
}

async function allowed(req, object) {
  if (object.bucket === "uniform-imports") {
    if (object.operation !== "download") return false;
    const batchId = req.headers["x-batch-id"];
    if (typeof batchId !== "string" || !/^[0-9a-f-]{36}$/i.test(batchId)) return false;
    const result = await db.query("select private.import_storage_capability($1,$2,$3) as allowed", [batchId, object.bucket, object.key]);
    return result.rows[0]?.allowed === true;
  }
  const attemptId = req.headers["x-attempt-id"];
  const leaseToken = req.headers["x-lease-token"];
  const generation = req.headers["x-lease-generation"];
  if (typeof attemptId !== "string" || typeof leaseToken !== "string" || typeof generation !== "string" || !/^\d+$/.test(generation)) return false;
  const result = await db.query("select private.renderer_storage_capability($1,$2,$3,$4,$5) as allowed", [object.bucket, object.key, attemptId, leaseToken, Number(generation)]);
  return result.rows[0]?.allowed === true;
}

function body(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    req.on("data", (chunk) => {
      length += chunk.length;
      if (length > maxBytes) reject(new Error("payload exceeds 20 MB"));
      else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  try {
    if (req.headers.authorization !== `Bearer ${proxyToken}`) { res.writeHead(401); res.end("unauthorized"); return; }
    const object = parseObjectPath(new URL(req.url ?? "/", "http://localhost").pathname);
    if (!object || (object.operation === "upload" && req.method !== "POST") || ((object.operation === "info" || object.operation === "download") && req.method !== "GET")) { res.writeHead(404); res.end("not found"); return; }
    if (!(await allowed(req, object))) { res.writeHead(403); res.end("renderer capability denied"); return; }
    const encodedKey = object.key.split("/").map(encodeURIComponent).join("/");
    const target = `${storageBase}/storage/v1/object/${object.operation === "info" ? "info/" : ""}${object.bucket}/${encodedKey}`;
    const response = await fetch(target, object.operation === "upload" ? {
      method: "POST",
      headers: { ...authHeaders, "content-type": req.headers["content-type"] ?? "application/octet-stream", "x-upsert": "false", "x-metadata": req.headers["x-metadata"] ?? "" },
      body: await body(req),
    } : { headers: authHeaders });
    const bytes = Buffer.from(await response.arrayBuffer());
    res.writeHead(response.status, { "content-type": response.headers.get("content-type") ?? "application/json" });
    res.end(bytes);
  } catch (error) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(error instanceof Error ? error.message : "proxy failure");
  }
});
const close = async () => { server.close(); await db.end(); };
process.on("SIGTERM", close);
process.on("SIGINT", close);
server.listen(port, "127.0.0.1", () => console.log(`renderer storage proxy listening on 127.0.0.1:${port}`));
