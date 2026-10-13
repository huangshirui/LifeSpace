import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const root = new URL("../", import.meta.url);
const api = JSON.parse(
  readFileSync(new URL("external-model.openapi.yaml", root), "utf8"),
);
const adapter = JSON.parse(
  readFileSync(new URL("external-adapter.contract.json", root), "utf8"),
);
assert.equal(api.info.version, "0.2.0");
assert.equal(adapter.properties.contractVersion.const, 1);
for (const op of [
  "connection",
  "discover",
  "get",
  "query",
  "create",
  "update",
  "delete",
])
  assert(adapter.properties.operation.enum.includes(op));
assert(api.paths["/api/v1/model-admin/external-sources"]?.post);
assert(!api.paths["/api/v1/spaces/{spaceId}/external-sources"]?.post);
assert(api.components.schemas.CreateSource.properties.credentialRef.writeOnly);
assert(!api.components.schemas.ExternalSource.properties.credentialRef);
assert(!api.components.schemas.DynamicRecord.properties.version);
const caps = api.components.schemas.ExternalCapabilities;
for (const key of [
  "atomicBatch",
  "transaction",
  "versionedWrite",
  "actions",
])
  assert.equal(caps.properties[key].const, false);
assert.equal(caps.properties.relationTargetResolution.type, "boolean");
assert(api.components.schemas.RegisterModel.properties.definitionKey);
const requestSchema =
  api.paths["/api/v1/spaces/{spaceId}/models/{modelKey}/records/{recordId}"]
    .delete.requestBody.content["application/json"].schema;
assert.equal(requestSchema.additionalProperties, false);
assert(!requestSchema.properties?.version);
const code = readFileSync(new URL("src/external-model.ts", root), "utf8");
assert(!/api\.notion\.com|Notion-Version/.test(code));
const migration = readFileSync(
  new URL("migrations/0055_external_models.sql", root),
  "utf8",
);
assert(migration.includes("UNIQUE(provider_key,resource_id)"));
assert(migration.includes("UPDATE schema_metadata SET value='55'"));
console.log("External Model/Adapter contract sanity check passed");
