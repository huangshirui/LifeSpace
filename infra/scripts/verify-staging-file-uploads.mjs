import assert from "node:assert/strict";
import { executeStagingD1Sql } from "./staging-d1-retry.mjs";

// Real R2 acceptance against the exact, manually deployed staging candidate.
// Synthetic records only. Never emit a bearer, signed URL or file contents.
const env = process.env;
const core = (env.LIFESPACE_CORE_STAGING_URL ?? "").replace(/\/+$/u, "");
if (new URL(core).hostname !== "core-staging.aisr.online") throw new Error("File smoke must target canonical staging Core");
for (const name of ["LIFESPACE_STAGING_USER_BEARER", "LIFESPACE_STAGING_MODEL_ADMIN_BEARER",
  "LIFESPACE_STAGING_SPACE_ID", "LIFESPACE_STAGING_SMOKE_APPLICATION_ID", "LIFESPACE_STAGING_SMOKE_SERVICE_PRINCIPAL_ID"]) {
  if (!env[name]) throw new Error(`${name} is required`);
}
const space = env.LIFESPACE_STAGING_SPACE_ID;
const marker = `${env.GITHUB_RUN_ID ?? "run"}_${env.GITHUB_RUN_ATTEMPT ?? "1"}_${crypto.randomUUID().slice(0, 8)}`
  .toLowerCase().replace(/[^a-z0-9_]/gu, "_").slice(0, 42);
const key = `smoke_file_${marker}`;
const base = `/api/v1/spaces/${space}`;
const sql = (command) => executeStagingD1Sql({ cwd: new URL("../../apps/core/", import.meta.url), sql: command });
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
let published = false, allowed = false, record = null, file = null;
const checks = { nativeUpload: false, immutableKey: false, attach: false, download: false, inUseDenial: false, softDeleteDetach: false, fileDeletion: false };

async function request(path, { method = "GET", body, admin = false } = {}) {
  const response = await fetch(`${core}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${admin ? env.LIFESPACE_STAGING_MODEL_ADMIN_BEARER : env.LIFESPACE_STAGING_USER_BEARER}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60000),
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  return { status: response.status, payload };
}

async function call(path, options = {}, expected = 200) {
  const result = await request(path, options);
  assert.equal(result.status, expected,
    `${options.method ?? "GET"} ${path}: expected ${expected}, got ${result.status}, code=${result.payload?.error?.code ?? "none"}`);
  return result.payload?.data;
}

async function directR2(url, method, headers = {}, body) {
  const parsed = new URL(url);
  assert.match(parsed.hostname, /^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/u);
  const response = await fetch(url, { method, headers, ...(body === undefined ? {} : { body }), signal: AbortSignal.timeout(60000) });
  assert.ok(response.ok, `Signed R2 ${method} failed: HTTP ${response.status}`);
  return response;
}

const cleanupErrors = [];
async function cleanup(label, task) {
  try { await task(); } catch { cleanupErrors.push(label); }
}

try {
  await call("/api/v1/model-admin/models", { method: "POST", admin: true, body: {
    compatibility: "initial",
    definition: {
      definitionVersion: 1, key,
      display: { singular: "Synthetic file smoke", plural: "Synthetic file smokes" },
      access: ["read", "write"],
      fields: {
        name: { type: "string", required: true },
        attachment: { type: "file", nullable: true },
        attachments: { type: "file_list", nullable: true },
      },
    },
  } }, 201);
  published = true;
  const now = new Date().toISOString();
  await sql(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id,created_at,updated_at)
    VALUES(${quote(env.LIFESPACE_STAGING_SMOKE_APPLICATION_ID)},${quote(key)},'write','service',${quote(env.LIFESPACE_STAGING_SMOKE_SERVICE_PRINCIPAL_ID)},${quote(now)},${quote(now)})`);
  allowed = true;
  // Model descriptors remain isolate-cached for up to one minute.
  await new Promise((resolve) => setTimeout(resolve, 65000));
  const discovery = await call(`${base}/_discovery/models/${key}`);
  assert.ok(discovery.fields.some((f) => f.key === "attachments" && f.type === "file_list"));

  const bytes = new TextEncoder().encode(`synthetic-file-smoke-${marker}`);
  const session = await call(`${base}/file-uploads`, { method: "POST", body: {
    modelKey: key, fieldKey: "attachments", name: "synthetic.txt", contentType: "text/plain", size: bytes.length,
  } }, 201);
  assert.match(session.id, /^upl_[a-f0-9]{32}$/u);
  const uploadPath = new URL(session.upload.url).pathname;
  assert.ok(uploadPath.includes("/uploads/native/"), "Client PUT must target a temporary Native upload object");
  assert.equal(session.upload.method, "PUT");
  await directR2(session.upload.url, "PUT", session.upload.headers, bytes);
  const uploaded = await call(`${base}/file-uploads/${session.id}/complete`, { method: "POST" });
  file = uploaded.id;
  assert.match(file, /^fil_[a-f0-9]{32}$/u);
  checks.nativeUpload = true;

  record = await call(`${base}/models/${key}/records`, { method: "POST",
    body: { name: `Synthetic ${marker}`, attachments: [file] } }, 201);
  assert.deepEqual(record.attachments, [file]);
  const fetched = await call(`${base}/models/${key}/records/${record.id}`);
  assert.deepEqual(fetched.attachments, [file]);
  checks.attach = true;
  const download = await call(`${base}/file-downloads`, { method: "POST", body: {
    modelKey: key, recordId: record.id, fieldKey: "attachments", fileId: file,
  } });
  assert.match(new URL(download.url).pathname, /\/files\//u);
  assert.notEqual(new URL(download.url).pathname, uploadPath, "Download must use a different permanent R2 object");
  assert.equal(new TextDecoder().decode(await (await directR2(download.url, "GET")).arrayBuffer()),
    new TextDecoder().decode(bytes));
  checks.immutableKey = true;
  checks.download = true;

  const referencedDelete = await request(`${base}/files/${file}`, { method: "DELETE" });
  assert.equal(referencedDelete.status, 409, "Referenced File must not be deleted");
  checks.inUseDenial = true;

  await call(`${base}/models/${key}/records/${record.id}`, {
    method: "DELETE", body: { version: record.version },
  }, 204);
  record = null;
  checks.softDeleteDetach = true;
  await call(`${base}/files/${file}`, { method: "DELETE" }, 204);
  checks.fileDeletion = true;
  file = null;
} finally {
  if (record) {
    await cleanup("delete synthetic Record", async () =>
      call(`${base}/models/${key}/records/${record.id}`, { method: "DELETE", body: { version: record.version } }, 204));
  }
  if (file) {
    await cleanup("delete synthetic Native File", async () => call(`${base}/files/${file}`, { method: "DELETE" }, 204));
  }
  if (published) {
    await cleanup("retire synthetic Model", async () =>
      call(`/api/v1/model-admin/models/${key}/retire`, { method: "POST", admin: true, body: {} }, 204));
  }
  if (allowed) {
    await cleanup("remove temporary application model access", async () =>
      sql(`DELETE FROM application_model_access WHERE application_id=${quote(env.LIFESPACE_STAGING_SMOKE_APPLICATION_ID)} AND model_key=${quote(key)}`));
  }
}
if (cleanupErrors.length) throw new Error(`File smoke cleanup failed: ${cleanupErrors.join(", ")}`);
assert.ok(Object.values(checks).every(Boolean), "Native File acceptance did not exercise every required invariant");
console.log(JSON.stringify({ ok: true, checks, cleanup: true }));
