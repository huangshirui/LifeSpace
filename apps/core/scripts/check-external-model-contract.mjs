import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const root = new URL("../", import.meta.url);
const api = JSON.parse(readFileSync(new URL("external-model.openapi.yaml", root), "utf8"));
const adapter = JSON.parse(readFileSync(new URL("external-adapter.contract.json", root), "utf8"));
assert.equal(api.info.version, "0.6.0");
assert.equal(adapter.properties.contractVersion.const, 1);
for (const op of ["connection", "discover", "get", "query", "create", "update", "delete"])
  assert(adapter.properties.operation.enum.includes(op));
assert(!api.paths["/api/v1/model-admin/external-sources"]);
assert(!api.paths["/api/v1/spaces/{spaceId}/external-sources"]);
assert(!api.components.schemas.CreateSource);
assert(!api.components.schemas.ExternalSource);
assert(!api.components.schemas.DynamicRecord.properties.version);
assert(!api.components.schemas.DynamicRecord.properties.origin);
assert(!api.components.schemas.DynamicRecord.properties.schemaHash);
assert.deepEqual(api.components.schemas.DynamicRecord.required, ["id", "spaceId", "modelKey"]);

// External must not define a second field-type vocabulary. The wire field carries
// the canonical type name; Core validates it through Model Definition's single
// Canonical Field Language.
const externalField = api.components.schemas.ExternalField;
const externalType = externalField.properties.type;
assert.equal(externalType.type, "string");
assert.equal(externalType.enum, undefined);
assert.equal(externalField.properties.key.pattern, "^[a-z][A-Za-z0-9]{0,62}$");
assert(!externalField.properties.key.pattern.includes("f_"));
assert(!externalField.properties.sourceFieldId);

const externalRuntime = readFileSync(new URL("src/external-runtime.ts", root), "utf8");
assert(externalRuntime.includes("normalizeCanonicalFieldValue"));
assert(externalRuntime.includes("recurrenceRuleSchema"));
assert(externalRuntime.includes("entityRefSchema"));
assert(!externalRuntime.includes("function typedValue("));
const externalModel = readFileSync(new URL("src/external-model.ts", root), "utf8");
assert(externalModel.includes("CanonicalFieldDefinition"));
assert(externalModel.includes("validateCanonicalFieldDefinition"));
const caps = api.components.schemas.ExternalCapabilities;
for (const key of ["atomicBatch", "transaction", "versionedWrite", "actions"])
  assert.equal(caps.properties[key].const, false);
assert.equal(caps.properties.relationTargetResolution.type, "boolean");
const register = api.components.schemas.RegisterModel;
assert.deepEqual(register.required, ["definitionKey", "connectionId", "resourceId", "declaredAccess"]);
assert(!register.properties.sourceId);
assert(!register.properties.credentialRef);
const requestSchema = api.paths["/api/v1/spaces/{spaceId}/models/{modelKey}/records/{recordId}"]
  .delete.requestBody.content["application/json"].schema;
assert.equal(requestSchema.additionalProperties, false);
assert(!requestSchema.properties?.version);
const code = readFileSync(new URL("src/external-model.ts", root), "utf8");
assert(!/api\.notion\.com|Notion-Version/u.test(code));
const routes = readFileSync(new URL("src/external-model-routes.ts", root), "utf8");
assert(!routes.includes("/external-sources"));
assert(!routes.includes("/model-admin/external-sources"));
assert(!routes.includes('"sourceId"'));
const migration = readFileSync(new URL("migrations/0055_external_models.sql", root), "utf8");
assert(migration.includes("UNIQUE(provider_key,resource_id)"));
assert(migration.includes("UPDATE schema_metadata SET value='55'"));
console.log("External Model dynamic-only binding/runtime contract sanity check passed");
