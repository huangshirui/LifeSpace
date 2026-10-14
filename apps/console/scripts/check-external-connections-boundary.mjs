import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const worker = readFileSync(new URL("../worker/external-connections.ts", import.meta.url), "utf8");
const ui = readFileSync(new URL("../src/ExternalConnectionsOverlay.tsx", import.meta.url), "utf8");
const wrangler = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const contract = JSON.parse(readFileSync(new URL("../../core/external-connection.openapi.yaml", import.meta.url), "utf8"));

assert.equal(wrangler.main, "worker/external-connections.ts");
assert(worker.includes('requestedScopes: ["profile:read", "spaces:manage"]'));
assert(!worker.includes("CORE_EXECUTOR_BEARER"));
assert(worker.includes('request.headers.get("origin") !== url.origin'));
assert(worker.includes('request.headers.get("sec-fetch-site") !== "same-origin"'));
for (const intent of ["create-external-connection", "update-external-connection", "revoke-external-connection", "bind-external-model"])
  assert(worker.includes(intent));
assert(worker.includes("x-lifespace-console-confirm-connection-id"));
assert(worker.includes('["providerKey", "displayName", "credential", "access"]'));
assert(!worker.includes('readJsonObject(request, ["providerKey", "displayName", "credential", "access", "credentialRef"]'));
assert(worker.includes("/external-model-definitions"));

assert(ui.includes('type="password"'));
assert(ui.includes("/external-connections/${connectionId}/resources"));
assert(ui.includes("/external-model-definitions"));
assert(!ui.includes('get<PublishedModel[]>("/api/models")'));
assert(ui.includes("connectionId, resourceId, declaredAccess: access"));
assert(ui.includes('selectedDefinition?.access.includes("write")'));
assert(!ui.includes("Data Source ID<input"));
assert(ui.includes("Provider token 只用于本次请求并保存到私有 Adapter Vault"));

assert(contract.paths["/api/v1/spaces/{spaceId}/external-connections"]?.post);
assert(contract.paths["/api/v1/spaces/{spaceId}/external-model-definitions"]?.get);
assert(contract.paths["/api/v1/spaces/{spaceId}/external-models"]?.post);
assert.equal(contract.components.schemas.ProviderCredential.writeOnly, true);
assert.equal(contract.components.schemas.CreateExternalConnection.properties.credential.writeOnly, true);
assert(!contract.components.schemas.CreateExternalConnection.properties.credentialRef);

console.log(JSON.stringify({
  ok: true,
  directUserSpaceAuthority: true,
  platformExecutorAbsent: true,
  platformModelAdminCatalogAbsentFromBindingFlow: true,
  csrfAndIntentProtected: true,
  destructiveConfirmationProtected: true,
  credentialRefServerOwned: true,
  providerCredentialPasswordInput: true,
  providerResourceDiscovery: true,
  spaceScopedDefinitionDiscovery: true,
  connectionIdBinding: true,
}));
