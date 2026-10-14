import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const root = new URL("../", import.meta.url);
const api = JSON.parse(readFileSync(new URL("external-model.openapi.yaml", root), "utf8"));
const executionAdapter = JSON.parse(readFileSync(new URL("external-adapter.contract.json", root), "utf8"));
const connectionApi = JSON.parse(readFileSync(new URL("external-connection.openapi.yaml", root), "utf8"));
const connectionAdapter = JSON.parse(readFileSync(new URL("external-connection-adapter.contract.json", root), "utf8"));

assert.equal(api.info.version, "0.2.0");
assert.equal(connectionApi.info.version, "0.1.0");
assert.equal(executionAdapter.properties.contractVersion.const, 1);
assert.equal(connectionAdapter.properties.contractVersion.const, 1);
for (const op of ["connection", "discover", "get", "query", "create", "update", "delete"])
  assert(executionAdapter.properties.operation.enum.includes(op));
for (const op of ["describe", "create", "update", "delete", "listResources"])
  assert(connectionAdapter.properties.operation.enum.includes(op));

// Deployment-managed credentialRef provisioning remains a separate service-only compatibility path.
assert(api.paths["/api/v1/model-admin/external-sources"]?.post);
assert(!api.paths["/api/v1/spaces/{spaceId}/external-sources"]?.post);
assert(api.components.schemas.CreateSource.properties.credentialRef.writeOnly);
assert(!api.components.schemas.ExternalSource.properties.credentialRef);

// Product setup is direct User/Space configuration and never accepts or returns credentialRef.
for (const path of [
  "/api/v1/spaces/{spaceId}/external-providers",
  "/api/v1/spaces/{spaceId}/external-connections",
  "/api/v1/spaces/{spaceId}/external-connections/{connectionId}",
  "/api/v1/spaces/{spaceId}/external-connections/{connectionId}/resources",
]) assert(connectionApi.paths[path]);
assert(connectionApi.paths["/api/v1/spaces/{spaceId}/external-connections"].post);
assert(connectionApi.paths["/api/v1/spaces/{spaceId}/external-models"].post);
assert(connectionApi.components.schemas.Credential.properties.token.writeOnly);
assert(!connectionApi.components.schemas.Connection.properties.credentialRef);
assert(!connectionApi.components.schemas.CreateConnection.properties.credentialRef);
assert(connectionApi.components.schemas.BindExternalModel.properties.connectionId);
assert(connectionAdapter.properties.credential.properties.token.writeOnly);

assert(!api.components.schemas.DynamicRecord.properties.version);
const caps = api.components.schemas.ExternalCapabilities;
for (const key of ["atomicBatch", "transaction", "versionedWrite", "actions"])
  assert.equal(caps.properties[key].const, false);
assert.equal(caps.properties.relationTargetResolution.type, "boolean");
assert(api.components.schemas.RegisterModel.properties.definitionKey);
const requestSchema = api.paths["/api/v1/spaces/{spaceId}/models/{modelKey}/records/{recordId}"].delete.requestBody.content["application/json"].schema;
assert.equal(requestSchema.additionalProperties, false);
assert(!requestSchema.properties?.version);

const runtimeCode = readFileSync(new URL("src/external-model.ts", root), "utf8");
const configurationCode = readFileSync(new URL("src/external-connection-routes.ts", root), "utf8");
assert(!/api\.notion\.com|Notion-Version/.test(runtimeCode));
assert(!/api\.notion\.com|Notion-Version/.test(configurationCode));
assert(configurationCode.includes('id("cnx")'));
assert(!configurationCode.includes("NOTION_CONNECTIONS"));

const modelMigration = readFileSync(new URL("migrations/0055_external_models.sql", root), "utf8");
assert(modelMigration.includes("UNIQUE(provider_key,resource_id)"));
assert(modelMigration.includes("UPDATE schema_metadata SET value='55'"));
const connectionMigration = readFileSync(new URL("migrations/0063_external_connection_configuration.sql", root), "utf8");
assert(connectionMigration.includes("credential_mode"));
assert(connectionMigration.includes("UPDATE schema_metadata SET value='63'"));

console.log("External Model/Connection/Adapter contract sanity check passed");
