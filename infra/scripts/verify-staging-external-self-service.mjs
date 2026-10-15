import assert from "node:assert/strict";
import { executeStagingD1Sql } from "./staging-d1-retry.mjs";

const env = process.env;
if (env.LIFESPACE_EXTERNAL_PROVIDER_ACTIVE !== "1" || env.LIFESPACE_EXTERNAL_SMOKE_SYNTHETIC_CONFIRMED !== "1") {
  throw new Error("Explicit synthetic staging External provider acceptance is required");
}
const baseUrl = env.LIFESPACE_CORE_STAGING_URL;
if (!baseUrl || new URL(baseUrl).hostname !== "core-staging.aisr.online") {
  throw new Error("External self-service smoke must target canonical staging Core");
}
for (const name of [
  "LIFESPACE_STAGING_USER_BEARER",
  "LIFESPACE_STAGING_MODEL_ADMIN_BEARER",
  "LIFESPACE_STAGING_SPACE_ID",
  "LIFESPACE_STAGING_SMOKE_APPLICATION_ID",
  "LIFESPACE_STAGING_SMOKE_SERVICE_PRINCIPAL_ID",
  "LIFESPACE_EXTERNAL_SMOKE_RESOURCE_ID",
  "NOTION_SMOKE_TOKEN",
]) {
  if (!env[name]) throw new Error(`${name} is required`);
}

const providerToken = env.NOTION_SMOKE_TOKEN;
if (providerToken !== providerToken.trim() || /[\r\n]/u.test(providerToken)) {
  throw new Error("NOTION_SMOKE_TOKEN is invalid");
}

const spaceId = env.LIFESPACE_STAGING_SPACE_ID;
const applicationId = env.LIFESPACE_STAGING_SMOKE_APPLICATION_ID;
const servicePrincipalId = env.LIFESPACE_STAGING_SMOKE_SERVICE_PRINCIPAL_ID;
const targetResourceId = String(env.LIFESPACE_EXTERNAL_SMOKE_RESOURCE_ID).replaceAll("-", "").toLowerCase();
const marker = `${env.GITHUB_RUN_ID ?? "run"}_${env.GITHUB_RUN_ATTEMPT ?? "1"}_${crypto.randomUUID().slice(0, 8)}`
  .replace(/[^a-z0-9_]/giu, "_")
  .toLowerCase()
  .slice(0, 42);
const definitionKey = `smoke_dynamic_${marker}`.slice(0, 63);
const coreDir = new URL("../../apps/core/", import.meta.url);
const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const sql = (command) => executeStagingD1Sql({ cwd: coreDir, sql: command });
const base = `/api/v1/spaces/${spaceId}`;

async function request(path, { method = "GET", body, role = "user" } = {}) {
  const bearer = role === "admin" ? env.LIFESPACE_STAGING_MODEL_ADMIN_BEARER : env.LIFESPACE_STAGING_USER_BEARER;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60000),
  });
  return {
    status: response.status,
    payload: response.status === 204 ? null : await response.json().catch(() => null),
  };
}

async function expectRequest(path, options = {}, expected = 200) {
  const result = await request(path, options);
  assert.equal(
    result.status,
    expected,
    `${options.method ?? "GET"} ${path} failed: HTTP ${result.status}, code=${result.payload?.error?.code ?? "none"}`,
  );
  return result.payload?.data;
}

async function allowDefinition() {
  const now = new Date().toISOString();
  await sql(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id,created_at,updated_at)
    VALUES(${quote(applicationId)},${quote(definitionKey)},'write','service',${quote(servicePrincipalId)},${quote(now)},${quote(now)})`);
}

let connectionId = null;
let registrationId = null;
let recordId = null;
let definitionPublished = false;
let modelAccessInserted = false;
let connectionRevoked = false;
const checks = {
  providerDiscovery: false,
  dynamicConnection: false,
  secretFreeCoreMetadata: false,
  resourceDiscovery: false,
  binding: false,
  runtime: false,
  refresh: false,
  accessDowngrade: false,
  credentialRotation: false,
  disableEnable: false,
  revoke: false,
  cleanup: false,
};
let failure;

try {
  const providers = await expectRequest(`${base}/external-providers`);
  const notion = providers.items.find((item) => item.key === "notion");
  assert.ok(notion, "Routed Notion provider descriptor is missing");
  assert.ok(notion.access.includes("read") && notion.access.includes("write"));
  checks.providerDiscovery = true;

  const created = await expectRequest(`${base}/external-connections`, {
    method: "POST",
    body: {
      providerKey: "notion",
      displayName: `Synthetic dynamic ${marker}`,
      credential: { type: notion.credential.type, token: providerToken },
      access: "write",
    },
  }, 201);
  connectionId = created.id;
  assert.match(connectionId, /^exs_[a-f0-9]{32}$/u);
  assert.equal(created.providerKey, "notion");
  assert.equal(created.resourceDiscovery, true);
  assert.equal(created.access, "write");
  assert.equal(Object.hasOwn(created, "managementMode"), false);
  assert.equal(Object.hasOwn(created, "credential"), false);
  assert.equal(Object.hasOwn(created, "credentialRef"), false);
  checks.dynamicConnection = true;

  const metadataRows = await sql(`SELECT id,provider_key,credential_ref,display_name,access_mode,status FROM external_sources WHERE id=${quote(connectionId)} AND space_id=${quote(spaceId)}`);
  const metadata = metadataRows.flatMap((result) => result.results ?? [])[0];
  assert.ok(metadata);
  assert.match(metadata.credential_ref, /^cnx_[a-f0-9]{32}$/u);
  assert.equal(metadata.provider_key, "notion");
  assert.equal(metadata.access_mode, "write");
  assert.equal(JSON.stringify(metadata).includes(providerToken), false);
  const listedConnections = await expectRequest(`${base}/external-connections`);
  assert.equal(JSON.stringify(listedConnections).includes(providerToken), false);
  assert.equal(JSON.stringify(listedConnections).includes(metadata.credential_ref), false);
  checks.secretFreeCoreMetadata = true;

  let cursor = null;
  let found = null;
  for (let page = 0; page < 10 && !found; page += 1) {
    const params = new URLSearchParams({ limit: "100" });
    if (cursor) params.set("cursor", cursor);
    const resources = await expectRequest(`${base}/external-connections/${connectionId}/resources?${params}`);
    found = resources.items.find((item) => item.id.replaceAll("-", "").toLowerCase() === targetResourceId) ?? null;
    cursor = resources.nextCursor;
    if (!cursor) break;
  }
  assert.ok(found, "Synthetic Notion Data Source was not discoverable through the dynamic Connection");
  assert.equal(found.type, "data_source");
  checks.resourceDiscovery = true;

  await expectRequest("/api/v1/model-admin/models", {
    method: "POST",
    role: "admin",
    body: {
      definition: {
        definitionVersion: 1,
        origin: "external",
        key: definitionKey,
        display: { singular: "Synthetic dynamic external", plural: "Synthetic dynamic external" },
        fields: {},
        access: ["read", "write"],
      },
      compatibility: "initial",
    },
  }, 201);
  definitionPublished = true;
  // Runtime Registry snapshots are isolate-local and may remain valid for 60 seconds.
  // This smoke publishes a run-scoped Definition immediately before binding it, so wait
  // past the documented bound before exercising the key through arbitrary staging isolates.
  await new Promise(resolve => setTimeout(resolve, 65_000));
  await allowDefinition();
  modelAccessInserted = true;

  const bound = await expectRequest(`${base}/external-models`, {
    method: "POST",
    body: {
      definitionKey,
      connectionId,
      resourceId: found.id,
      declaredAccess: "write",
    },
  }, 201);
  registrationId = bound.registrationId;
  assert.match(registrationId, /^ext_[a-f0-9]{32}$/u);
  assert.equal(bound.connectionId, connectionId);
  assert.equal(bound.origin, "external");
  const title = bound.fields.find((field) => field.title === "Name" && field.type === "string" && field.writable);
  const amount = bound.fields.find((field) => field.title === "Amount" && field.type === "number" && field.writable);
  assert.ok(title && amount, "Synthetic source must expose writable Name and Amount fields");
  checks.binding = true;

  const record = await expectRequest(`${base}/models/${definitionKey}/records`, {
    method: "POST",
    body: { [title.key]: `Dynamic acceptance ${marker}`, [amount.key]: 23 },
  }, 201);
  recordId = record.id;
  assert.equal(record.origin, "external");
  assert.equal(record.version, undefined);
  const fetched = await expectRequest(`${base}/models/${definitionKey}/records/${recordId}`);
  assert.equal(fetched.id, recordId);
  assert.equal(fetched[amount.key], 23);
  checks.runtime = true;

  await expectRequest(`${base}/external-models/${definitionKey}/refresh`, { method: "POST", body: {} });
  checks.refresh = true;

  const readOnly = await expectRequest(`${base}/external-connections/${connectionId}`, {
    method: "PATCH",
    body: { access: "read" },
  });
  assert.equal(readOnly.access, "read");
  const bindingList = await expectRequest(`${base}/external-models`);
  const listedBinding = bindingList.items.find((item) => item.registrationId === registrationId);
  assert.equal(listedBinding?.declaredAccess, "read", "Connection downgrade must synchronously narrow binding access");
  const raiseWhileRead = await request(`${base}/external-models/${definitionKey}`, {
    method: "PATCH",
    body: { declaredAccess: "write" },
  });
  assert.equal(raiseWhileRead.status, 422, "Binding cannot exceed read-only Connection ceiling");
  const writeWhileRead = await request(`${base}/models/${definitionKey}/records`, {
    method: "POST",
    body: { [title.key]: `Denied dynamic ${marker}`, [amount.key]: 99 },
  });
  assert.equal(writeWhileRead.status, 405, "Runtime write capability must disappear after Connection downgrade before Provider execution");
  assert.equal(writeWhileRead.payload?.error?.code, "MODEL_OPERATION_UNSUPPORTED", "Read-only External binding must fail at the model capability boundary");
  checks.accessDowngrade = true;

  const rotated = await expectRequest(`${base}/external-connections/${connectionId}`, {
    method: "PATCH",
    body: {
      credential: { type: notion.credential.type, token: providerToken },
      access: "write",
    },
  });
  assert.equal(rotated.access, "write");
  await expectRequest(`${base}/external-models/${definitionKey}`, {
    method: "PATCH",
    body: { declaredAccess: "write" },
  });
  const updated = await expectRequest(`${base}/models/${definitionKey}/records/${recordId}`, {
    method: "PATCH",
    body: { [amount.key]: 24 },
  });
  assert.equal(updated[amount.key], 24);
  checks.credentialRotation = true;

  await expectRequest(`${base}/external-connections/${connectionId}`, {
    method: "PATCH",
    body: { status: "disabled" },
  });
  const disabledRead = await request(`${base}/models/${definitionKey}/records/${recordId}`);
  assert.ok([403, 404].includes(disabledRead.status), "Disabled dynamic Connection must remove runtime availability");
  await expectRequest(`${base}/external-connections/${connectionId}`, {
    method: "PATCH",
    body: { status: "active" },
  });
  assert.equal((await expectRequest(`${base}/models/${definitionKey}/records/${recordId}`)).id, recordId);
  checks.disableEnable = true;

  await expectRequest(`${base}/models/${definitionKey}/records/${recordId}`, { method: "DELETE", body: {} }, 204);
  recordId = null;
  await expectRequest(`${base}/external-connections/${connectionId}`, { method: "DELETE" }, 204);
  connectionRevoked = true;
  const afterRevoke = await expectRequest(`${base}/external-models`);
  assert.equal(afterRevoke.items.find((item) => item.registrationId === registrationId)?.status, "disabled");
  const resourcesAfterRevoke = await request(`${base}/external-connections/${connectionId}/resources`);
  assert.equal(resourcesAfterRevoke.status, 409);
  checks.revoke = true;
} catch (error) {
  failure = error;
}

const cleanupFailures = [];
const errorText = (error) => error instanceof Error ? error.message : String(error);
async function cleanup(label, action) {
  try { await action(); } catch (error) { cleanupFailures.push(`${label}: ${errorText(error)}`); }
}

if (recordId && definitionPublished) {
  await cleanup("synthetic Provider record", async () => {
    if (connectionId && !connectionRevoked) {
      const restoredConnection = await request(`${base}/external-connections/${connectionId}`, {
        method: "PATCH",
        body: { access: "write", status: "active" },
      });
      assert.equal(
        restoredConnection.status,
        200,
        `cleanup restore Connection failed: HTTP ${restoredConnection.status}, code=${restoredConnection.payload?.error?.code ?? "none"}`,
      );
      if (registrationId) {
        const restoredBinding = await request(`${base}/external-models/${definitionKey}`, {
          method: "PATCH",
          body: { declaredAccess: "write" },
        });
        assert.equal(
          restoredBinding.status,
          200,
          `cleanup restore binding failed: HTTP ${restoredBinding.status}, code=${restoredBinding.payload?.error?.code ?? "none"}`,
        );
      }
    }
    const result = await request(`${base}/models/${definitionKey}/records/${recordId}`, { method: "DELETE", body: {} });
    assert.ok(
      [204, 404, 502, 503].includes(result.status),
      `cleanup Provider record failed: HTTP ${result.status}, code=${result.payload?.error?.code ?? "none"}`,
    );
  });
}
if (connectionId && !connectionRevoked) {
  await cleanup("dynamic Connection revoke", async () => {
    const result = await request(`${base}/external-connections/${connectionId}`, { method: "DELETE" });
    assert.ok(
      [204, 404].includes(result.status),
      `cleanup Connection revoke failed: HTTP ${result.status}, code=${result.payload?.error?.code ?? "none"}`,
    );
  });
}
if (definitionPublished) {
  await cleanup("External definition retirement", async () => {
    const result = await request(`/api/v1/model-admin/models/${definitionKey}/retire`, { method: "POST", role: "admin", body: {} });
    assert.ok(
      [204, 404].includes(result.status),
      `cleanup Definition retirement failed: HTTP ${result.status}, code=${result.payload?.error?.code ?? "none"}`,
    );
  });
}
if (modelAccessInserted) {
  await cleanup("Application Model Access cleanup", () =>
    sql(`DELETE FROM application_model_access WHERE application_id=${quote(applicationId)} AND model_key=${quote(definitionKey)}`));
}
if (connectionId) {
  await cleanup("run-scoped External metadata cleanup", () =>
    sql(`DELETE FROM external_record_identities WHERE space_id=${quote(spaceId)} AND model_key IN (SELECT model_key FROM external_models WHERE source_id=${quote(connectionId)} AND space_id=${quote(spaceId)});
      DELETE FROM external_models WHERE source_id=${quote(connectionId)} AND space_id=${quote(spaceId)};
      DELETE FROM external_sources WHERE id=${quote(connectionId)} AND space_id=${quote(spaceId)};`));
}
checks.cleanup = cleanupFailures.length === 0;

if (failure) {
  if (failure instanceof Error && cleanupFailures.length) {
    failure.message += `; cleanup failures: ${cleanupFailures.join(" | ")}`;
  }
  if (failure instanceof Error) throw failure;
  throw new Error(`External self-service acceptance failed: ${errorText(failure)}${cleanupFailures.length ? `; cleanup failures: ${cleanupFailures.join(" | ")}` : ""}`);
}
if (cleanupFailures.length) {
  throw new Error(`External self-service acceptance cleanup failed: ${cleanupFailures.join(" | ")}`);
}

console.log(JSON.stringify({
  ok: true,
  providerRevision: env.LIFESPACE_EXTERNAL_PROVIDER_REVISION,
  checks,
  credentialBoundary: "staging smoke token was supplied only to the public Dynamic Connection API; output excludes token/credentialRef",
}));
