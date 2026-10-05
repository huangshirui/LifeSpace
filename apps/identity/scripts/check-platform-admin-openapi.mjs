import fs from "node:fs";
import YAML from "yaml";

const document = YAML.parse(fs.readFileSync(new URL("../platform-admin.openapi.yaml", import.meta.url), "utf8"));

if (document.openapi !== "3.1.0" || document.info?.version !== "0.4.0") {
  throw new Error("Identity Platform Admin OpenAPI version metadata is invalid");
}
if (!document.info?.title?.includes("Platform Admin")) {
  throw new Error("Identity control-plane OpenAPI must identify itself as Platform Admin");
}

const requiredPaths = [
  "/api/v1/me/platform-admin-actor-token",
  "/bootstrap/v1/platform-administrators",
  "/bootstrap/v1/platform-administrators/{userId}",
  "/internal/v1/platform-admin/applications",
  "/internal/v1/platform-admin/applications/{applicationId}",
  "/internal/v1/platform-admin/applications/{applicationId}/credentials",
  "/internal/v1/platform-admin/applications/{applicationId}/credentials/{credentialId}",
  "/internal/v1/platform-admin/applications/{applicationId}/access-audiences",
  "/internal/v1/platform-admin/applications/{applicationId}/access-audiences/{audienceId}",
  "/internal/v1/platform-admin/applications/{applicationId}/agents",
  "/internal/v1/platform-admin/applications/{applicationId}/agents/{agentId}",
  "/internal/v1/platform-admin/applications/{applicationId}/agents/{agentId}/api-credentials",
  "/internal/v1/platform-admin/applications/{applicationId}/agents/{agentId}/api-credentials/{credentialId}",
  "/internal/v1/platform-admin/users",
  "/internal/v1/platform-admin/users/{userId}",
  "/internal/v1/platform-admin/applications/{applicationId}/service-principals",
  "/internal/v1/platform-admin/applications/{applicationId}/service-principals/{principalId}",
  "/internal/v1/platform-admin/applications/{applicationId}/service-principals/{principalId}/tokens",
  "/internal/v1/platform-admin/applications/{applicationId}/service-principals/{principalId}/tokens/{tokenId}",
  "/internal/v1/platform-admin/audit",
];
for (const path of requiredPaths) {
  if (!document.paths?.[path]) throw new Error(`Identity Platform Admin OpenAPI missing ${path}`);
}

const schemes = document.components?.securitySchemes ?? {};
if (schemes.applicationCredential?.bearerFormat?.includes("lsa_") !== true) {
  throw new Error("Identity Platform Admin executor must be a server-only lsa_ application credential");
}
if (schemes.platformAdminActor?.name !== "X-LifeSpace-Actor-Token") {
  throw new Error("Identity Platform Admin actor header contract is missing");
}
if (!String(schemes.platformAdminActor?.description ?? "").includes("purpose=platform_admin_actor")) {
  throw new Error("Identity Platform Admin actor proof must be purpose-bound");
}
if (!String(schemes.bootstrapSecret?.description ?? "").includes("never a routine Console runtime credential")) {
  throw new Error("Bootstrap secret must be documented as break-glass-only for Console architecture");
}

const actor = document.paths?.["/api/v1/me/platform-admin-actor-token"]?.post;
if (!actor?.security?.some((entry) => entry?.userBearer)) {
  throw new Error("Actor-proof issuance must require an ordinary authenticated LifeSpace user");
}
const actorSchema = document.components?.schemas?.PlatformAdminActorTokenResponse?.properties?.data?.properties;
if (actorSchema?.expiresIn?.const !== 300 || actorSchema?.purpose?.const !== "platform_admin_actor") {
  throw new Error("Actor-proof response must freeze five-minute purpose-bound semantics");
}

function dualSecurity(operation, label) {
  const security = operation?.security ?? [];
  if (!security.some((entry) => entry?.applicationCredential && entry?.platformAdminActor)) {
    throw new Error(`${label} must require Console executor and human actor proof together`);
  }
}

dualSecurity(document.paths?.["/internal/v1/platform-admin/applications"]?.get, "Application Admin");
dualSecurity(document.paths?.["/internal/v1/platform-admin/applications/{applicationId}/agents"]?.get, "Agent Admin");
dualSecurity(document.paths?.["/internal/v1/platform-admin/applications/{applicationId}/agents"]?.post, "Agent Admin create");
dualSecurity(document.paths?.["/internal/v1/platform-admin/applications/{applicationId}/agents/{agentId}"]?.patch, "Agent Admin update");
dualSecurity(document.paths?.["/internal/v1/platform-admin/applications/{applicationId}/agents/{agentId}/api-credentials"]?.get, "Agent credential list");
dualSecurity(document.paths?.["/internal/v1/platform-admin/applications/{applicationId}/agents/{agentId}/api-credentials"]?.post, "Agent credential create");
dualSecurity(document.paths?.["/internal/v1/platform-admin/applications/{applicationId}/agents/{agentId}/api-credentials/{credentialId}"]?.patch, "Agent credential update");
dualSecurity(document.paths?.["/internal/v1/platform-admin/applications/{applicationId}/agents/{agentId}/api-credentials/{credentialId}"]?.delete, "Agent credential revoke");
dualSecurity(document.paths?.["/internal/v1/platform-admin/users"]?.get, "Identity Inspector");
dualSecurity(document.paths?.["/internal/v1/platform-admin/applications/{applicationId}/service-principals"]?.get, "Service Admin");
dualSecurity(document.paths?.["/internal/v1/platform-admin/audit"]?.get, "Identity audit");

const users = document.paths?.["/internal/v1/platform-admin/users"];
const user = document.paths?.["/internal/v1/platform-admin/users/{userId}"];
if (!users?.get || users.post || users.patch || users.delete || !user?.get || user.post || user.patch || user.delete) {
  throw new Error("Identity Inspector must remain read-only");
}

const agentCreate = document.paths?.["/internal/v1/platform-admin/applications/{applicationId}/agents"]?.post;
if (!String(agentCreate?.description ?? "").includes("no Space/model authority") || !String(agentCreate?.description ?? "").includes("no Delegation")) {
  throw new Error("Platform Agent creation must explicitly grant no Space/model authority and create no Delegation");
}
const agentUpdate = document.paths?.["/internal/v1/platform-admin/applications/{applicationId}/agents/{agentId}"]?.patch;
if (!String(agentUpdate?.description ?? "").includes("Global status affects every Application binding")) {
  throw new Error("Platform Agent status must remain explicitly global across Application bindings");
}

const agentCredentialCreate = document.paths?.["/internal/v1/platform-admin/applications/{applicationId}/agents/{agentId}/api-credentials"]?.post;
if (!String(agentCredentialCreate?.description ?? "").includes("lsp_agt_*")
  || !String(agentCredentialCreate?.description ?? "").includes("no Space/model/User Authority")
  || !String(agentCredentialCreate?.description ?? "").includes("exactly once")) {
  throw new Error("Platform-managed Agent API credential must preserve no-authority and one-time-secret semantics");
}
const agentCredentialPatch = document.paths?.["/internal/v1/platform-admin/applications/{applicationId}/agents/{agentId}/api-credentials/{credentialId}"]?.patch;
if (!String(agentCredentialPatch?.description ?? "").includes("never be expanded")) {
  throw new Error("Platform-managed Agent API credential authority must remain reduction-only");
}

const tokenPatch = document.paths?.["/internal/v1/platform-admin/applications/{applicationId}/service-principals/{principalId}/tokens/{tokenId}"]?.patch;
if (!String(tokenPatch?.description ?? "").includes("never be expanded")) {
  throw new Error("Platform-managed Service API Token scopes must remain reduction-only");
}
const createdSecret = document.paths?.["/internal/v1/platform-admin/applications/{applicationId}/service-principals/{principalId}/tokens"]?.post;
if (!String(createdSecret?.description ?? "").includes("exactly once")) {
  throw new Error("Platform-managed Service API Token plaintext must be one-time-only");
}
if (!String(createdSecret?.description ?? "").includes("lsp_svc_*")) {
  throw new Error("Platform-managed Service API Token issuance must advertise canonical lsp_svc_*");
}

const serialized = JSON.stringify(document);
if (serialized.includes("secretHash") || serialized.includes("privateKey")) {
  throw new Error("Identity Platform Admin contract must never expose stored secret material");
}

console.log("Identity Platform Admin OpenAPI contract sanity check passed");
