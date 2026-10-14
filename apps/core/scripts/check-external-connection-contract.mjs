import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const root = new URL("../", import.meta.url);
const api = JSON.parse(readFileSync(new URL("external-connection.openapi.yaml", root), "utf8"));
const adapter = JSON.parse(readFileSync(new URL("external-connection-adapter.contract.json", root), "utf8"));

assert.equal(api.info.version, "0.1.0");
assert.equal(adapter.properties.contractVersion.const, 1);
for (const operation of ["describe", "create", "update", "delete", "listResources"])
  assert(adapter.properties.operation.enum.includes(operation));

const base = "/api/v1/spaces/{spaceId}/external-connections";
assert(api.paths["/api/v1/spaces/{spaceId}/external-providers"]?.get);
assert(api.paths["/api/v1/spaces/{spaceId}/external-model-definitions"]?.get);
assert(api.paths[base]?.get);
assert(api.paths[base]?.post);
assert(api.paths[`${base}/{connectionId}`]?.patch);
assert(api.paths[`${base}/{connectionId}`]?.delete);
assert(api.paths[`${base}/{connectionId}/resources`]?.get);
assert(api.paths["/api/v1/spaces/{spaceId}/external-models"]?.post);

const create = api.components.schemas.CreateExternalConnection;
assert.equal(create.additionalProperties, false);
assert.equal(create.properties.credential.writeOnly, true);
assert(!create.properties.credentialRef);
assert(create.required.includes("credential"));
const connection = api.components.schemas.ExternalConnection;
assert(!connection.properties.credential);
assert(!connection.properties.credentialRef);
assert.deepEqual(connection.properties.managementMode.enum, ["dynamic", "deployment"]);
const binding = api.components.schemas.BindExternalModel;
assert.deepEqual(binding.required, ["definitionKey", "connectionId", "resourceId", "declaredAccess"]);
assert(!binding.properties.sourceId);

const code = readFileSync(new URL("src/external-connections.ts", root), "utf8");
assert(code.includes("/internal/v1/external-connections"));
assert(!/api\.notion\.com|Notion-Version/u.test(code));
assert(!/credential_ref:\s*input|credentialRef:\s*input/u.test(code));
const definitions = readFileSync(new URL("src/external-connection-definition-routes.ts", root), "utf8");
assert(definitions.includes('model.definition.origin === "external"'));
assert(definitions.includes('requireScope("spaces:manage")'));

const migration = readFileSync(new URL("migrations/0063_external_connections.sql", root), "utf8");
assert(migration.includes("ADD COLUMN access_mode"));
assert(migration.includes("ADD COLUMN revoked_at"));
assert(migration.includes("value='63'"));

console.log("External Connection public/Adapter contract sanity check passed");
