import fs from "node:fs";
import YAML from "yaml";

const document = YAML.parse(fs.readFileSync(new URL("../platform-admin.openapi.yaml", import.meta.url), "utf8"));

if (document.openapi !== "3.1.0" || document.info?.version !== "0.5.0") {
  throw new Error("Core Platform Admin OpenAPI version metadata is invalid");
}
if (!document.info?.title?.includes("Platform Admin")) {
  throw new Error("Core control-plane OpenAPI must identify itself as Platform Admin");
}

const requiredPaths = [
  "/api/v1/platform-admin/applications/{applicationId}/model-access",
  "/api/v1/platform-admin/spaces",
  "/api/v1/platform-admin/spaces/{spaceId}",
  "/api/v1/platform-admin/spaces/{spaceId}/grants",
  "/api/v1/platform-admin/spaces/{spaceId}/grants/{grantId}",
  "/api/v1/platform-admin/models",
  "/api/v1/platform-admin/models/validate",
  "/api/v1/platform-admin/models/{modelKey}",
  "/api/v1/platform-admin/models/{modelKey}/retire",
  "/api/v1/platform-admin/audit",
];
for (const path of requiredPaths) {
  if (!document.paths?.[path]) throw new Error(`Core Platform Admin OpenAPI missing ${path}`);
}

for (const path of Object.keys(document.paths ?? {})) {
  if (path.startsWith("/api/v1/model-admin/")) {
    throw new Error(`Platform Admin contract must not expose the independent Model Control Plane namespace: ${path}`);
  }
}

const schemes = document.components?.securitySchemes ?? {};
if (schemes.bearerAuth?.type !== "http" || schemes.platformAdminActor?.name !== "X-LifeSpace-Actor-Token") {
  throw new Error("Core Platform Admin dual-auth security schemes are incomplete");
}
if (schemes.bearerAuth?.bearerFormat !== "service JWT or lsp_svc_* Service API Token (legacy lsp_pat_* accepted)") {
  throw new Error("Core Platform Admin must advertise canonical lsp_svc_* Service API Tokens and legacy lsp_pat_* migration compatibility");
}
const globalSecurity = document.security ?? [];
if (!globalSecurity.some((entry) => entry?.bearerAuth && entry?.platformAdminActor)) {
  throw new Error("Core Platform Admin operations must require executor and actor proof together");
}

const spaces = document.paths?.["/api/v1/platform-admin/spaces"];
const space = document.paths?.["/api/v1/platform-admin/spaces/{spaceId}"];
if (!spaces?.get || spaces.post || spaces.patch || spaces.delete || !space?.get || space.post || space.patch || space.delete) {
  throw new Error("Platform Space inspector resources must remain read-only; mutations belong on explicit nested governance resources");
}
if (!String(spaces.get.description ?? "").includes("does not create") || !String(spaces.get.description ?? "").includes("Space membership")) {
  throw new Error("Platform Space Inspector must document that it does not grant Space membership");
}

const grants = document.paths?.["/api/v1/platform-admin/spaces/{spaceId}/grants"];
const grant = document.paths?.["/api/v1/platform-admin/spaces/{spaceId}/grants/{grantId}"];
if (!grants?.post || grants.get || grants.patch || grants.delete || !grant?.patch || !grant?.delete || grant.get || grant.post) {
  throw new Error("Platform Data Grant governance lifecycle drifted");
}
for (const operation of [grants.post, grant.patch, grant.delete]) {
  const description = String(operation?.description ?? "");
  if (!description.includes("grants:manage") || !description.includes("platform-admin actor proof")) {
    throw new Error("Platform Data Grant mutation must document grants:manage plus platform-admin actor authority");
  }
}
const grantTypes = document.components?.schemas?.PlatformDataGrant?.properties?.granteeType?.enum ?? [];
if (!grantTypes.includes("agent") || !grantTypes.includes("service")) {
  throw new Error("Platform Data Grant governance must expose Agent and Service grantees");
}

const modelAccess = document.paths?.["/api/v1/platform-admin/applications/{applicationId}/model-access"];
if (!modelAccess?.get || !modelAccess?.put || modelAccess.post || modelAccess.patch || modelAccess.delete) {
  throw new Error("Application x Model Access control-plane lifecycle drifted");
}

const models = document.paths?.["/api/v1/platform-admin/models"];
const validate = document.paths?.["/api/v1/platform-admin/models/validate"];
const model = document.paths?.["/api/v1/platform-admin/models/{modelKey}"];
const retire = document.paths?.["/api/v1/platform-admin/models/{modelKey}/retire"];
if (!models?.get || !models?.post || !validate?.post || !model?.get || !retire?.post) {
  throw new Error("Platform Admin Model governance lifecycle is incomplete");
}
for (const operation of [models.get, models.post, validate.post, model.get, retire.post]) {
  if (!String(operation?.description ?? "").includes("platform-admin actor proof") && !String(operation?.description ?? "").includes("actor proof")) {
    throw new Error("Platform Admin Model operation must document human actor proof");
  }
}
const publishSchemaRef = models.post?.requestBody?.content?.["application/json"]?.schema?.$ref;
if (publishSchemaRef !== "./model-control-plane.openapi.yaml#/components/schemas/PublishModelRequest") {
  throw new Error("Platform Admin model publish must reuse the Model Control Plane request schema");
}
const validateSchemaRef = validate.post?.requestBody?.content?.["application/json"]?.schema?.$ref;
if (validateSchemaRef !== "./model-control-plane.openapi.yaml#/components/schemas/ValidateModelRequest") {
  throw new Error("Platform Admin model validation must reuse the Model Control Plane request schema");
}

const auditResult = document.components?.schemas?.PlatformAuditEntry?.properties?.result?.enum ?? [];
if (auditResult.join(",") !== "pending,success,failure") {
  throw new Error("Core Platform Admin audit states must preserve pending/success/failure evidence");
}
const actorPurpose = schemes.platformAdminActor?.description ?? "";
if (!actorPurpose.includes("purpose=platform_admin_actor") || !actorPurpose.includes("<=5-minute")) {
  throw new Error("Platform Admin actor scheme must document the purpose-bound five-minute proof");
}

const serialized = JSON.stringify(document);
for (const forbidden of ["x-bootstrap-secret", "IDENTITY_BOOTSTRAP_SECRET", "secretHash", "privateKey"]) {
  if (serialized.includes(forbidden)) throw new Error(`Core Platform Admin contract leaked forbidden runtime authority: ${forbidden}`);
}

console.log("Core Platform Admin OpenAPI contract sanity check passed");
