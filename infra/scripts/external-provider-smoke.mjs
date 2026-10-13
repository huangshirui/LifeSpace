import assert from "node:assert/strict";

// Dependency-injected orchestration: the same flow runs against live staging
// and synthetic request fixtures. Never retry writes or print Provider payloads.
export async function runExternalProviderSmoke({ request, allowModels, cleanupMetadata, verifyScheduledRefresh, spaceId, resourceId, credentialRef, marker }) {
  const externalKey = `smoke_ext_${marker}`, nativeKey = `smoke_link_${marker}`;
  const base = `/api/v1/spaces/${spaceId}`;
  const records = [], definitions = [], edges = [], nativeRecords = [];
  let source, registration, native;
  const samples = [];
  async function call(path, method = "GET", body, role = "user", status = 200) {
    const start = performance.now();
    const result = await request(path, { method, body, role });
    samples.push({ method, milliseconds: Math.round(performance.now() - start) });
    assert.equal(result.status, status, `${method} staging operation failed: HTTP ${result.status}, code=${result.payload?.error?.code ?? "none"}`);
    return result.payload?.data;
  }
  let failure;
  try {
    source = (await call("/api/v1/model-admin/external-sources", "POST", { spaceId, providerKey: "notion", credentialRef }, "admin", 201)).id;
    for (const [key, origin] of [[externalKey, "external"], [nativeKey, "native"]]) {
      await call("/api/v1/model-admin/models", "POST", { definition: { definitionVersion: 1, key, ...(origin === "external" ? { origin } : {}), display: { singular: "Synthetic smoke", plural: "Synthetic smoke" }, fields: origin === "external" ? {} : { name: { type: "string" } }, access: ["read", "write"], semanticRelations: { outgoing: ["relates_to"] } }, compatibility: "initial" }, "admin", 201);
      definitions.push(key);
    }
    await allowModels([externalKey, nativeKey]);
    const detail = await call(`${base}/external-models`, "POST", { sourceId: source, resourceId, definitionKey: externalKey, declaredAccess: "write" }, "user", 201);
    registration = detail.registrationId;
    assert.equal(detail.origin, "external");
    const title = detail.fields.find(f => f.title === "Name" && f.type === "string" && f.writable);
    const amount = detail.fields.find(f => f.title === "Amount" && f.type === "number" && f.writable && f.operators.includes("eq"));
    assert.ok(title && amount, "Synthetic data source must have writable Name (title) and Amount (number) properties");
    const discovered = await call(`${base}/_discovery/models/${externalKey}`);
    assert.equal(discovered.schemaHash, detail.schemaHash);
    assert.equal(discovered.origin, "external");
    const path = `${base}/models/${externalKey}/records`;
    const record = await call(path, "POST", { [title.key]: `Synthetic acceptance ${marker}`, [amount.key]: 17 }, "user", 201);
    records.push(record.id);
    assert.equal(record.origin, "external"); assert.equal(record.version, undefined);
    assert.equal((await call(`${path}/${record.id}`))[amount.key], 17);
    let queried = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      const query = await call(`${path}/query`, "POST", { filter: { field: amount.key, op: "eq", value: 17 }, page: { limit: 100 } });
      if (query.items.some(item => item.id === record.id)) { queried = true; break; }
      if (attempt < 5) await new Promise(resolve => setTimeout(resolve, 2000));
    }
    assert.ok(queried, "Provider query did not converge to the confirmed synthetic create");
    assert.equal((await call(`${path}/${record.id}`, "PATCH", { [amount.key]: 18 }))[amount.key], 18);
    native = await call(`${base}/models/${nativeKey}/records`, "POST", { name: `Synthetic relation ${marker}` }, "user", 201);
    nativeRecords.push(native);
    const input = { source: { kind: "record", modelKey: nativeKey, recordId: native.id }, predicate: "relates_to", target: { kind: "record", modelKey: externalKey, recordId: record.id } };
    const edge = await call(`${base}/semantic-relations`, "POST", input);
    edges.push(edge.id);
    const hydrated = await call(`${base}/semantic-relations/${edge.id}?hydrate=both`);
    assert.equal(hydrated.targetRecord.id, record.id); assert.equal(hydrated.targetRecord.origin, "external"); assert.equal(hydrated.targetRecord.version, undefined);
    await call(`${base}/models/batch`, "POST", { operations: [{ operation: "relation_create", ...input }] }, "user", 422);
    const partial = await call(`${base}/models/batch`, "POST", { atomicConsistency: false, operations: [{ operation: "create", modelKey: externalKey, data: { unavailable_smoke_field: 1 } }, { operation: "relation_create", ...input }, { operation: "create", modelKey: nativeKey, data: { name: `Independent Native ${marker}` } }] });
    if (partial.items[2]?.status === "succeeded" && partial.items[2].recordId) nativeRecords.push({ id: partial.items[2].recordId, version: partial.items[2].version });
    assert.deepEqual(partial.items.map(item => item.status), ["failed", "succeeded", "succeeded"]);
    if (partial.items[1].relationId && !edges.includes(partial.items[1].relationId)) edges.push(partial.items[1].relationId);
    await call(`${base}/external-models/${externalKey}/refresh`, "POST", {});
    await verifyScheduledRefresh(registration);
    await call(`${base}/external-sources/${source}`, "PATCH", { status: "disabled" });
    const denied = await request(`${path}/${record.id}`, { method: "GET", role: "user" });
    assert.ok([403, 404].includes(denied.status), "Disabled Source must remove runtime availability");
    await call(`${base}/external-sources/${source}`, "PATCH", { status: "active" });
    assert.equal((await call(`${path}/${record.id}`)).id, record.id);
    await call(`${path}/${record.id}`, "DELETE", {}, "user", 204);
    records.splice(0, 1);
    await call(`${base}/semantic-relations/${edge.id}`, "GET", undefined, "user", 404);
    edges.length = 0;
  } catch (error) { failure = error; }
  const cleanupFailures = [];
  async function cleanup(label, action) { try { await action(); } catch { cleanupFailures.push(label); } }
  // Confirmed synthetic IDs only; an unknown create is never retried.
  if (source) await cleanup("source reactivation", () => call(`${base}/external-sources/${source}`, "PATCH", { status: "active" }));
  for (const id of edges) await cleanup("relation removal", async () => { const r = await request(`${base}/semantic-relations/${id}`, { method: "DELETE", role: "user" }); assert.ok([204, 404].includes(r.status)); });
  for (const id of records) await cleanup("synthetic provider page trash", () => call(`${base}/models/${externalKey}/records/${id}`, "DELETE", {}, "user", 204));
  for (const record of nativeRecords) await cleanup("synthetic Native deletion", () => call(`${base}/models/${nativeKey}/records/${record.id}`, "DELETE", { version: record.version }, "user", 204));
  if (source) await cleanup("source disable", () => call(`${base}/external-sources/${source}`, "PATCH", { status: "disabled" }));
  for (const key of definitions.reverse()) await cleanup("smoke definition retirement", () => call(`/api/v1/model-admin/models/${key}/retire`, "POST", {}, "admin", 204));
  await cleanup("run-scoped binding metadata removal", () => cleanupMetadata({ source, registration, externalKey, nativeKey }));
  if (cleanupFailures.length) throw new Error(`External acceptance cleanup failed: ${cleanupFailures.join(", ")}; original check=${failure ? "failed" : "passed"}`);
  if (failure) throw failure;
  return { ok: true, connection: true, discovery: true, crud: true, semanticRelations: true, partialBatch: true, scheduledRefresh: true, sourceRevocation: true, cleanup: true, samples };
}
