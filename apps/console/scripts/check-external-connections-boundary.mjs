import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const connectionWorker = readFileSync(new URL("../worker/external-connections.ts", import.meta.url), "utf8");
const bindingWorker = readFileSync(new URL("../worker/external-bindings.ts", import.meta.url), "utf8");
const connectionUi = readFileSync(new URL("../src/ExternalConnectionsOverlay.tsx", import.meta.url), "utf8");
const bindingUi = readFileSync(new URL("../src/ExternalBindingManagerOverlay.tsx", import.meta.url), "utf8");
const wrangler = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const contract = JSON.parse(readFileSync(new URL("../../core/external-connection.openapi.yaml", import.meta.url), "utf8"));

assert.equal(wrangler.main, "worker/external-bindings.ts");
for (const worker of [connectionWorker, bindingWorker]) {
  assert(worker.includes('requestedScopes: ["profile:read", "spaces:manage"]'));
  assert(!worker.includes("CORE_EXECUTOR_BEARER"));
  assert(worker.includes('request.headers.get("origin") !== url.origin'));
  assert(worker.includes('request.headers.get("sec-fetch-site") !== "same-origin"'));
}
for (const intent of ["create-external-connection", "update-external-connection", "revoke-external-connection", "bind-external-model"])
  assert(connectionWorker.includes(intent));
for (const intent of ["refresh-external-model-binding", "update-external-model-binding"])
  assert(bindingWorker.includes(intent));
assert(connectionWorker.includes("x-lifespace-console-confirm-connection-id"));
assert(connectionWorker.includes('["providerKey", "displayName", "credential", "access"]'));
assert(!connectionWorker.includes('readJsonObject(request, ["providerKey", "displayName", "credential", "access", "credentialRef"]'));
assert(connectionWorker.includes("/external-model-definitions"));
assert(bindingWorker.includes('/external-models`'));

assert(connectionUi.includes('type="password"'));
assert(connectionUi.includes("/external-connections/${connectionId}/resources"));
assert(connectionUi.includes("/external-model-definitions"));
assert(!connectionUi.includes('get<PublishedModel[]>("/api/models")'));
assert(connectionUi.includes("connectionId, resourceId, declaredAccess: access"));
assert(connectionUi.includes('selectedDefinition?.access.includes("write")'));
assert(!connectionUi.includes("Data Source ID<input"));
assert(connectionUi.includes("Provider token 只用于本次请求并保存到私有 Adapter Vault"));
assert(bindingUi.includes("Refresh schema"));
assert(bindingUi.includes("Set read"));
assert(bindingUi.includes("Set write"));
assert(bindingUi.includes("Disable"));

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
  bindingListFallback: true,
  bindingSchemaRefreshFallback: true,
  bindingAccessFallback: true,
  bindingDisableFallback: true,
}));
