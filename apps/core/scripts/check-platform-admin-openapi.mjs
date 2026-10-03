import fs from "node:fs";
import YAML from "yaml";

const document = YAML.parse(fs.readFileSync(new URL("../platform-admin.openapi.yaml", import.meta.url), "utf8"));

if (document.openapi !== "3.1.0" || document.info?.version !== "0.4.0") {
  throw new Error("Core Platform Admin OpenAPI version metadata is invalid");
}
if (!document.info?.title?.includes("Platform Admin")) {
  throw new Error("Core control-plane OpenAPI must identify itself as Platform Admin");
}

const requiredPaths = [
  "/api/v1/platform-admin/applications/{applicationId}/model-access",
  "/api/v1/platform-admin/spaces",
  "/api/v1/platform-admin/spaces/{spaceId}",
  "/api/v1/platform-admin/audit",
  "/api/v1/model-admin/models",
  "/api/v1/model-admin/models/{modelKey}/retire",
];
for (const path of requiredPaths) {
  if (!document.paths?.[path]) throw new Error(`Core Platform Admin OpenAPI missing ${path}`);
}

const schemes = document.components?.securitySchemes ?? {};
if (schemes.bearerAuth?.type !== "http" || schemes.platformAdminActor?.name !== "X-LifeSpace-Actor-Token") {
  throw new Error("Core Platform Admin dual-auth security schemes are incomplete");
}
const globalSecurity = document.security ?? [];
if (!globalSecurity.some((entry) => entry?.bearerAuth && entry?.platformAdminActor)) {
  throw new Error("Core Platform Admin operations must require executor and actor proof together");
}

const spaces = document.paths?.["/api/v1/platform-admin/spaces"];
const space = document.paths?.["/api/v1/platform-admin/spaces/{spaceId}"];
if (!spaces?.get || spaces.post || spaces.patch || spaces.delete || !space?.get || space.post || space.patch || space.delete) {
  throw new Error("Platform Space Inspector must remain read-only");
}
if (!String(spaces.get.description ?? "").includes("does not create or imply Space membership")) {
  throw new Error("Platform Space Inspector must document that it does not grant Space membership");
}
const grantTypes = document.components?.schemas?.PlatformDataGrant?.properties?.granteeType?.enum ?? [];
if (!grantTypes.includes("agent")) {
  throw new Error("Platform Space Inspector must expose Agent Data Grants");
}

const modelAccess = document.paths?.["/api/v1/platform-admin/applications/{applicationId}/model-access"];
if (!modelAccess?.get || !modelAccess?.put || modelAccess.post || modelAccess.patch || modelAccess.delete) {
  throw new Error("Application x Model Access control-plane lifecycle drifted");
}

for (const path of ["/api/v1/model-admin/models", "/api/v1/model-admin/models/{modelKey}/retire"]) {
  const operation = document.paths?.[path]?.post;
  if (!String(operation?.description ?? "").includes("actor proof")) {
    throw new Error(`Console Model Admin operation must document human actor proof: ${path}`);
  }
}

const publishSchemaRef = document.paths?.["/api/v1/model-admin/models"]?.post?.requestBody?.content?.["application/json"]?.schema?.$ref;
if (publishSchemaRef !== "./model-control-plane.openapi.yaml#/components/schemas/PublishModelRequest") {
  throw new Error("Platform Admin Console publish profile must reuse the Model Control Plane request schema");
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
