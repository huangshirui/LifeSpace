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
const notionVersion = "2025-09-03";
const startDateProperty = "LS Start Date";
const renamedStartDateProperty = `${startDateProperty} Renamed`;
const tagsProperty = "LS Tags";
const filesProperty = "LS Files";
const alphaTag = "Alpha";
const betaTag = "Beta";

async function notionRequest(path, { method = "GET", body } = {}) {
  const response = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${providerToken}`,
      accept: "application/json",
      "Notion-Version": notionVersion,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      `Notion synthetic resource setup failed: ${method} ${path} HTTP ${response.status}, code=${payload?.code ?? "none"}`,
    );
  }
  return payload;
}

function propertyList(schema) {
  return Object.values(schema?.properties ?? {}).filter((property) => property && typeof property === "object");
}

function propertyNamed(schema, name) {
  return propertyList(schema).find((property) => property.name === name) ?? null;
}

async function ensureSyntheticProviderSchema() {
  let schema = await notionRequest(`/data_sources/${targetResourceId}`);
  const additions = {};
  for (const [name, type, definition] of [
    [startDateProperty, "date", { date: {} }],
    [tagsProperty, "multi_select", { multi_select: { options: [{ name: alphaTag }, { name: betaTag }] } }],
    [filesProperty, "files", { files: {} }],
  ]) {
    const current = propertyNamed(schema, name);
    if (current && current.type !== type) {
      throw new Error(`Synthetic Notion property ${name} must be ${type}, found ${current.type}`);
    }
    if (!current) additions[name] = definition;
  }
  if (Object.keys(additions).length) {
    await notionRequest(`/data_sources/${targetResourceId}`, {
      method: "PATCH",
      body: { properties: additions },
    });
    schema = await notionRequest(`/data_sources/${targetResourceId}`);
  }

  const tags = propertyNamed(schema, tagsProperty);
  const existingTagNames = new Set((tags?.multi_select?.options ?? []).map((option) => option.name));
  if (!existingTagNames.has(alphaTag) || !existingTagNames.has(betaTag)) {
    const existing = (tags?.multi_select?.options ?? []).map((option) => ({ id: option.id, name: option.name }));
    const missing = [alphaTag, betaTag]
      .filter((name) => !existingTagNames.has(name))
      .map((name) => ({ name }));
    await notionRequest(`/data_sources/${targetResourceId}`, {
      method: "PATCH",
      body: { properties: { [tagsProperty]: { multi_select: { options: [...existing, ...missing] } } } },
    });
    schema = await notionRequest(`/data_sources/${targetResourceId}`);
  }

  for (const [name, type] of [
    [startDateProperty, "date"],
    [tagsProperty, "multi_select"],
    [filesProperty, "files"],
  ]) {
    assert.equal(propertyNamed(schema, name)?.type, type, `Synthetic Notion property ${name} was not prepared as ${type}`);
  }
}

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

function providerPageId(recordId) {
  const match = /^rec_external_[a-f0-9]{32}_([a-f0-9]{32})$/u.exec(recordId);
  assert.ok(match, `Unexpected Notion-backed External record id ${recordId}`);
  return match[1];
}

function assertReadablePublicKey(field) {
  assert.match(field.key, /^[a-z][A-Za-z0-9]{0,62}$/u);
  assert.equal(field.key.startsWith("f_"), false, `${field.title} leaked legacy f_<hash> key`);
  assert.equal(Object.hasOwn(field, "sourceFieldId"), false, `${field.title} leaked Provider sourceFieldId`);
}

let connectionId = null;
let registrationId = null;
let recordId = null;
let secondaryRecordId = null;
let definitionPublished = false;
let modelAccessInserted = false;
let connectionRevoked = false;
let startDateRenamed = false;
const checks = {
  providerSchema: false,
  providerDiscovery: false,
  dynamicConnection: false,
  secretFreeCoreMetadata: false,
  resourceDiscovery: false,
  binding: false,
  fieldProjection: false,
  runtime: false,
  canonicalQuery: false,
  stableKeyRefresh: false,
  refresh: false,
  accessDowngrade: false,
  credentialRotation: false,
  disableEnable: false,
  revoke: false,
  cleanup: false,
  providerFileUpload: false,
};
let failure;

try {
  await ensureSyntheticProviderSchema();
  checks.providerSchema = true;

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
  const startDate = bound.fields.find((field) => field.title === startDateProperty && field.type === "date" && field.writable);
  const tags = bound.fields.find((field) => field.title === tagsProperty && field.type === "enum_list" && field.writable);
  const files = bound.fields.find((field) => field.title === filesProperty && field.type === "file_ref_list" && !field.writable);
  assert.ok(title && amount, "Synthetic source must expose writable Name and Amount fields");
  assert.ok(startDate, `${startDateProperty} must project as writable date`);
  assert.ok(tags, `${tagsProperty} must project as writable enum_list`);
  assert.ok(files, `${filesProperty} must project as read-only file_ref_list`);
  assert.ok(startDate.operators.includes("eq") && startDate.sortable, "Start Date must advertise filter and sort");
  assert.deepEqual(tags.operators, ["contains"]);
  assert.equal(tags.sortable, false);
  assert.equal(files.sortable, false);
  assert.deepEqual(files.upload, { supported: true, maxBytes: 20 * 1024 * 1024 }, "Writable Notion Connection must advertise separate upload capability");
  for (const field of [title, amount, startDate, tags, files]) assertReadablePublicKey(field);
  checks.binding = true;
  checks.fieldProjection = true;

  const record = await expectRequest(`${base}/models/${definitionKey}/records`, {
    method: "POST",
    body: {
      [title.key]: `Field A ${marker}`,
      [amount.key]: 23,
      [startDate.key]: "2026-10-17",
      [tags.key]: [alphaTag],
    },
  }, 201);
  recordId = record.id;
  assert.equal(record.origin, undefined);
  assert.equal(record.schemaHash, undefined);
  assert.equal(record.version, undefined);
  let fetched = await expectRequest(`${base}/models/${definitionKey}/records/${recordId}`);
  assert.equal(fetched.id, recordId);
  assert.equal(fetched[amount.key], 23);
  assert.equal(fetched[startDate.key], "2026-10-17");
  assert.deepEqual(fetched[tags.key], [alphaTag]);
  assert.deepEqual(fetched[files.key], []);
  assert.equal(fetched.origin, undefined);
  assert.equal(fetched.schemaHash, undefined);

  await notionRequest(`/pages/${providerPageId(recordId)}`, {
    method: "PATCH",
    body: {
      properties: {
        [startDateProperty]: {
          date: {
            start: "2026-10-17T14:30:00+08:00",
            end: "2026-10-20T18:00:00+08:00",
          },
        },
        [filesProperty]: {
          files: [{
            name: "LifeSpace field-contract smoke",
            external: { url: "https://example.com/lifespace-field-contract-smoke.pdf" },
          }],
        },
      },
    },
  });
  fetched = await expectRequest(`${base}/models/${definitionKey}/records/${recordId}`);
  assert.equal(fetched[startDate.key], "2026-10-17", "datetime range must project Provider start as Start Date");
  assert.deepEqual(fetched[files.key], [{
    name: "LifeSpace field-contract smoke",
    url: "https://example.com/lifespace-field-contract-smoke.pdf",
  }]);
  checks.runtime = true;

  // One synthetic Notion-hosted file added through the canonical LifeSpace
  // Upload Session. The original external reference must survive the PATCH.
  const fileBytes = new TextEncoder().encode(`synthetic-notion-upload-${marker}`);
  const session = await expectRequest(`${base}/file-uploads`, { method: "POST", body: {
    modelKey: definitionKey,
    recordId,
    fieldKey: files.key,
    name: `synthetic-${marker}.txt`,
    contentType: "text/plain",
    size: fileBytes.length,
  } }, 201);
  assert.match(session.id, /^upl_[a-f0-9]{32}$/u);
  assert.equal(session.destination, "external");
  assert.ok(new URL(session.upload.url).pathname.includes("/uploads/external/"));
  const staged = await fetch(session.upload.url, {
    method: "PUT",
    headers: session.upload.headers,
    body: fileBytes,
    signal: AbortSignal.timeout(60000),
  });
  assert.ok(staged.ok, `Notion R2 staging upload failed: HTTP ${staged.status}`);
  const uploadedRecord = await expectRequest(`${base}/file-uploads/${session.id}/complete`, { method: "POST" });
  assert.equal(uploadedRecord.id, recordId);
  const refs = uploadedRecord[files.key];
  assert.ok(Array.isArray(refs) && refs.length === 2, "Notion file append must preserve the existing reference");
  assert.equal(refs[0].url, "https://example.com/lifespace-field-contract-smoke.pdf");
  assert.equal(refs[1].name, `synthetic-${marker}.txt`);
  assert.ok(refs[1].url.startsWith("https://"), "Notion must own the final file URL");
  assert.ok(typeof refs[1].expiresAt === "string", "Notion upload must return the provider's signed file URL expiry");
  checks.providerFileUpload = true;

  const tagQuery = await expectRequest(`${base}/models/${definitionKey}/records/query`, {
    method: "POST",
    body: {
      filter: { field: tags.key, op: "contains", value: alphaTag },
      page: { limit: 100 },
    },
  });
  assert.ok(tagQuery.items.some((item) => item.id === recordId), "enum_list contains query did not find the record");

  const dateQuery = await expectRequest(`${base}/models/${definitionKey}/records/query`, {
    method: "POST",
    body: {
      filter: { field: startDate.key, op: "eq", value: "2026-10-17" },
      page: { limit: 100 },
    },
  });
  assert.ok(dateQuery.items.some((item) => item.id === recordId), "Start Date equality query did not match datetime/range Provider value");

  const secondary = await expectRequest(`${base}/models/${definitionKey}/records`, {
    method: "POST",
    body: {
      [title.key]: `Field B ${marker}`,
      [amount.key]: 24,
      [startDate.key]: "2026-10-18",
      [tags.key]: [betaTag],
    },
  }, 201);
  secondaryRecordId = secondary.id;
  const sorted = await expectRequest(`${base}/models/${definitionKey}/records/query`, {
    method: "POST",
    body: {
      filter: { field: title.key, op: "contains", value: marker },
      sort: [{ field: startDate.key, direction: "asc" }],
      page: { limit: 100 },
    },
  });
  const firstIndex = sorted.items.findIndex((item) => item.id === recordId);
  const secondIndex = sorted.items.findIndex((item) => item.id === secondaryRecordId);
  assert.ok(firstIndex >= 0 && secondIndex >= 0 && firstIndex < secondIndex, "Start Date provider sort did not order 2026-10-17 before 2026-10-18");
  await expectRequest(`${base}/models/${definitionKey}/records/${secondaryRecordId}`, { method: "DELETE", body: {} }, 204);
  secondaryRecordId = null;
  checks.canonicalQuery = true;

  const originalStartDateKey = startDate.key;
  await notionRequest(`/data_sources/${targetResourceId}`, {
    method: "PATCH",
    body: { properties: { [startDateProperty]: { name: renamedStartDateProperty } } },
  });
  startDateRenamed = true;
  let refreshed = await expectRequest(`${base}/external-models/${definitionKey}/refresh`, { method: "POST", body: {} });
  const renamedDate = refreshed.fields.find((field) => field.title === renamedStartDateProperty && field.type === "date");
  assert.equal(renamedDate?.key, originalStartDateKey, "Provider rename changed stable public field key");
  await notionRequest(`/data_sources/${targetResourceId}`, {
    method: "PATCH",
    body: { properties: { [renamedStartDateProperty]: { name: startDateProperty } } },
  });
  startDateRenamed = false;
  refreshed = await expectRequest(`${base}/external-models/${definitionKey}/refresh`, { method: "POST", body: {} });
  assert.equal(refreshed.fields.find((field) => field.title === startDateProperty)?.key, originalStartDateKey);
  checks.stableKeyRefresh = true;
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

if (startDateRenamed) {
  await cleanup("synthetic Provider property-name restore", async () => {
    await notionRequest(`/data_sources/${targetResourceId}`, {
      method: "PATCH",
      body: { properties: { [renamedStartDateProperty]: { name: startDateProperty } } },
    });
    startDateRenamed = false;
  });
}

for (const [label, id] of [["secondary synthetic Provider record", secondaryRecordId], ["synthetic Provider record", recordId]]) {
  if (id && definitionPublished) {
    await cleanup(label, async () => {
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
      const result = await request(`${base}/models/${definitionKey}/records/${id}`, { method: "DELETE", body: {} });
      assert.ok(
        [204, 404, 502, 503].includes(result.status),
        `cleanup Provider record failed: HTTP ${result.status}, code=${result.payload?.error?.code ?? "none"}`,
      );
    });
  }
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
  credentialBoundary: "staging smoke token was supplied only to the public Dynamic Connection API and dedicated synthetic Provider setup; output excludes token/credentialRef",
}));
