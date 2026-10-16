import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const worker = readFileSync(new URL("../worker/external-connections.ts", import.meta.url), "utf8");
const platformEntry = readFileSync(new URL("../worker/platform-admin-entry.ts", import.meta.url), "utf8");
const platformOverview = readFileSync(new URL("../worker/platform-overview.ts", import.meta.url), "utf8");
const downstreamWorker = readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
const ui = readFileSync(new URL("../src/ExternalConnectionsOverlay.tsx", import.meta.url), "utf8");
const controlPlaneUi = readFileSync(new URL("../src/ControlPlaneApp.tsx", import.meta.url), "utf8");
const entry = readFileSync(new URL("../src/main.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/external-connections.css", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const wrangler = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const contract = JSON.parse(readFileSync(new URL("../../core/external-connection.openapi.yaml", import.meta.url), "utf8"));
const platformAdminContractSource = readFileSync(new URL("../../core/platform-admin.openapi.yaml", import.meta.url), "utf8");

assert.equal(wrangler.main, "worker/platform-admin-entry.ts");
assert(platformEntry.includes('url.pathname === "/api/overview"'));
assert(platformEntry.includes("platformOverviewWorker.fetch"));
assert(platformEntry.includes("externalConnectionsWorker.fetch"));
assert(platformOverview.includes('"/api/v1/platform-admin/models"'));
assert(!platformOverview.includes("/api/v1/model-admin/"));
assert(worker.includes('requestedScopes: ["profile:read"]'));
assert(!worker.includes('requestedScopes: ["profile:read", "spaces:manage"]'));
assert(worker.includes("CORE_EXECUTOR_BEARER"));
assert(worker.includes("/api/v1/me/platform-admin-actor-token"));
assert(worker.includes("x-lifespace-actor-token"));
assert(worker.includes("/api/v1/platform-admin/spaces/"));
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
assert(worker.includes("forwardBindingDetail"));
assert(worker.includes("projectExternalField"));
assert(!worker.includes("sourceFieldId"));
assert(worker.includes('/external-models/${encodeURIComponent(modelKey)}/refresh'));
assert(worker.includes('["status", "declaredAccess"]'));

assert(ui.includes('type="password"'));
assert(ui.includes("/external-connections/${connectionId}/resources"));
assert(ui.includes("/external-model-definitions"));
assert(!ui.includes('get<PublishedModel[]>("/api/models")'));
assert(ui.includes("{ definitionKey, connectionId, resourceId, declaredAccess: access }"));
assert(ui.includes('selectedDefinition?.access.includes("write")'));
assert(!ui.includes("Data Source ID<input"));
assert(ui.includes("Provider token 只用于本次请求并保存到私有 Adapter Vault"));
assert(ui.includes("当前模型绑定"));
assert(ui.includes("查看字段"));
assert(ui.includes("配置态 snapshot；运行时消费者仍以 Space Discovery 为准"));
assert(ui.includes("field.operators"));
assert(ui.includes("field.sortable"));
assert(ui.includes("field.writable"));
assert(ui.includes("refresh-external-model-binding"));
assert(ui.includes("update-external-model-binding"));
assert(ui.includes("disabled binding 也通过这里重新绑定同一资源恢复"));
assert(!ui.includes("managementMode"));
assert(!ui.includes("deployment 类型"));
assert(!ui.includes("ExternalBindingManagerOverlay"));
assert(!ui.includes("external-data-space"));
assert(entry.includes('window.addEventListener("popstate", update)'));
assert(entry.includes("<ExternalConnectionsOverlay key={routeKey} />"));
assert(!css.includes("external-data-space"));
assert(css.includes('.ext-launcher::before{content:"Configure"'));
assert(css.includes(".ext-schema-detail"));
assert(css.includes(".ext-field-table"));
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
assert(contract.paths["/api/v1/spaces/{spaceId}/external-models/{modelKey}"]?.get);
assert(contract.paths["/api/v1/spaces/{spaceId}/external-models/{modelKey}"]?.patch);
assert(contract.paths["/api/v1/spaces/{spaceId}/external-models/{modelKey}/refresh"]?.post);
assert(!contract.paths["/api/v1/spaces/{spaceId}/external-sources"]);
assert(!contract.paths["/api/v1/model-admin/external-sources"]);
assert.equal(contract.info.version, "0.4.0");
assert.equal(contract.components.schemas.ProviderCredential.writeOnly, true);
assert.equal(contract.components.schemas.CreateExternalConnection.properties.credential.writeOnly, true);
assert(!contract.components.schemas.CreateExternalConnection.properties.credentialRef);
assert(!contract.components.schemas.ExternalConnection.properties.managementMode);
assert(contract.components.schemas.ExternalBindingDetail.required.includes("fields"));
assert(!contract.components.schemas.ExternalField.properties.sourceFieldId);

for (const path of [
  "/api/v1/platform-admin/spaces/{spaceId}/external-providers",
  "/api/v1/platform-admin/spaces/{spaceId}/external-model-definitions",
  "/api/v1/platform-admin/spaces/{spaceId}/external-connections",
  "/api/v1/platform-admin/spaces/{spaceId}/external-connections/{connectionId}",
  "/api/v1/platform-admin/spaces/{spaceId}/external-connections/{connectionId}/resources",
  "/api/v1/platform-admin/spaces/{spaceId}/external-models",
  "/api/v1/platform-admin/spaces/{spaceId}/external-models/{modelKey}",
  "/api/v1/platform-admin/spaces/{spaceId}/external-models/{modelKey}/refresh",
]) assert(platformAdminContractSource.includes(`  ${path}:`), `Platform Admin contract missing ${path}`);

console.log(JSON.stringify({
  ok: true,
  consolePlatformAdminAuthorityOnly: true,
  platformAdminEntrypoint: true,
  platformOverviewNamespaceOnly: true,
  platformExecutorRequired: true,
  platformActorProofRequired: true,
  platformModelAdminCatalogAbsentFromBindingFlow: true,
  csrfAndIntentProtected: true,
  destructiveConfirmationProtected: true,
  credentialRefServerOwned: true,
  providerCredentialPasswordInput: true,
  providerResourceDiscovery: true,
  spaceScopedDefinitionDiscovery: true,
  storedSchemaInspection: true,
  runtimeDiscoveryAuthorityNotReusedForConfiguration: true,
  connectionIdBinding: true,
  dynamicConnectionsOnly: true,
  bindingLifecycleInCanonicalExternalData: true,
  spaRouteSynchronized: true,
  controlPlaneVisualPatternAligned: true,
  legacyBindingUiRemoved: true,
  legacyBindingBffRemoved: true,
  legacyBindingTestRemoved: true,
  legacyLauncherHidingRemoved: true,
}));
