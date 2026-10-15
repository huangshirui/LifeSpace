import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const worker = readFileSync(new URL("../worker/external-connections.ts", import.meta.url), "utf8");
const downstreamWorker = readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
const ui = readFileSync(new URL("../src/ExternalConnectionsOverlay.tsx", import.meta.url), "utf8");
const controlPlaneUi = readFileSync(new URL("../src/ControlPlaneApp.tsx", import.meta.url), "utf8");
const entry = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/external-connections.css", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const wrangler = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const contract = JSON.parse(readFileSync(new URL("../../core/external-connection.openapi.yaml", import.meta.url), "utf8"));

assert.equal(wrangler.main, "worker/external-connections.ts");
assert(worker.includes('requestedScopes: ["profile:read", "spaces:manage"]'));
assert(!worker.includes("CORE_EXECUTOR_BEARER"));
assert(worker.includes('request.headers.get("origin") !== url.origin'));
assert(worker.includes('request.headers.get("sec-fetch-site") !== "same-origin"'));
for (const intent of [
  "create-external-connection",
  "update-external-connection",
  "revoke-external-connection",
  "bind-external-model",
  "refresh-external-model-binding",
  "update-external-model-binding",
]) assert(worker.includes(intent));
assert(worker.includes("x-lifespace-console-confirm-connection-id"));
assert(worker.includes('["providerKey", "displayName", "credential", "access"]'));
assert(!worker.includes('readJsonObject(request, ["providerKey", "displayName", "credential", "access", "credentialRef"]'));
assert(worker.includes("/external-model-definitions"));
assert(worker.includes('request.method === "GET"'));
assert(worker.includes('/external-models/${encodeURIComponent(modelKey)}/refresh'));
assert(worker.includes('["status", "declaredAccess"]'));

assert(ui.includes('type="password"'));
assert(ui.includes("/external-connections/${connectionId}/resources"));
assert(ui.includes("/external-model-definitions"));
assert(!ui.includes('get<PublishedModel[]>("/api/models")'));
assert(ui.includes("connectionId: nextConnection"));
assert(ui.includes("resourceId: nextResource"));
assert(ui.includes("declaredAccess: nextAccess"));
assert(ui.includes('selectedDefinition?.access.includes("write")'));
assert(!ui.includes("Data Source ID<input"));
assert(ui.includes("Provider token 只用于本次请求并保存到私有 Adapter Vault"));
assert(ui.includes("当前模型绑定"));
assert(ui.includes("refresh-external-model-binding"));
assert(ui.includes("update-external-model-binding"));
assert(!ui.includes("ExternalBindingManagerOverlay"));
assert(!ui.includes("external-data-space"));
assert(entry.includes('window.addEventListener("popstate", update)'));
assert(entry.includes("<ExternalConnectionsOverlay key={routeKey} />"));
assert(!css.includes("external-data-space"));
assert(css.includes('.ext-launcher::before{content:"Configure"'));
assert(css.includes('background:var(--blue)'));
assert(css.includes('box-shadow:0 18px 48px rgba(21,38,67,.18)'));
assert(css.includes('box-shadow:0 30px 90px rgba(10,24,47,.28)'));

assert(!controlPlaneUi.includes('type: "external-binding"'));
assert(!controlPlaneUi.includes("ExternalBindingDialog"));
assert(!controlPlaneUi.includes("绑定外部模型"));
assert(!downstreamWorker.includes("externalBindingRoute"));
assert(!downstreamWorker.includes("external-sources|external-models"));
assert(!downstreamWorker.includes('"sourceId"'));
assert(!packageJson.scripts?.["test:external-binding"]);
assert(!String(packageJson.scripts?.check ?? "").includes("test:external-binding"));

assert(contract.paths["/api/v1/spaces/{spaceId}/external-connections"]?.post);
assert(contract.paths["/api/v1/spaces/{spaceId}/external-model-definitions"]?.get);
assert(contract.paths["/api/v1/spaces/{spaceId}/external-models"]?.get);
assert(contract.paths["/api/v1/spaces/{spaceId}/external-models"]?.post);
assert(contract.paths["/api/v1/spaces/{spaceId}/external-models/{modelKey}"]?.patch);
assert(contract.paths["/api/v1/spaces/{spaceId}/external-models/{modelKey}/refresh"]?.post);
assert.equal(contract.info.version, "0.2.0");
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
  bindingLifecycleInCanonicalExternalData: true,
  spaRouteSynchronized: true,
  controlPlaneVisualPatternAligned: true,
  legacyBindingUiRemoved: true,
  legacyBindingBffRemoved: true,
  legacyBindingTestRemoved: true,
  legacyLauncherHidingRemoved: true,
}));
