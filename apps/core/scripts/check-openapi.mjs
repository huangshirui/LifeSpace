import fs from "node:fs";
import YAML from "yaml";

const document = YAML.parse(fs.readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8"));

if (document.openapi !== "3.1.0" || document.info?.version !== "0.14.0") {
  throw new Error("Core Kernel OpenAPI version metadata is invalid");
}
if (!document.info?.title?.includes("Kernel")) {
  throw new Error("Static Core OpenAPI must identify itself as the Kernel contract");
}
if (!document.info?.description?.includes("Model Contract Revision")) {
  throw new Error("Kernel OpenAPI must explain the separate immutable Model Contract surface");
}

const requiredPaths = [
  "/health",
  "/api/v1/status",
  "/assets/spaces/{spaceId}/avatar",
  "/api/v1/me",
  "/api/v1/me/spaces",
  "/api/v1/spaces",
  "/api/v1/spaces/{spaceId}",
  "/api/v1/spaces/{spaceId}/avatar",
  "/api/v1/spaces/{spaceId}/members",
  "/api/v1/spaces/{spaceId}/members/{userId}",
  "/api/v1/spaces/{spaceId}/leave",
  "/api/v1/spaces/{spaceId}/invites",
  "/api/v1/spaces/{spaceId}/invites/{inviteId}/revoke",
  "/api/v1/space-invites/{token}",
  "/api/v1/space-invites/{token}/join",
  "/api/v1/spaces/{spaceId}/grants",
  "/api/v1/spaces/{spaceId}/grants/{grantId}",
  "/api/v1/event-subscriptions",
  "/api/v1/event-subscriptions/{subscriptionId}",
  "/api/v1/event-subscriptions/{subscriptionId}/deliveries",
  "/api/v1/event-subscriptions/{subscriptionId}/test",
  "/api/v1/spaces/{spaceId}/creation-drafts",
  "/api/v1/spaces/{spaceId}/creation-drafts/{draftId}",
  "/api/v1/spaces/{spaceId}/creation-drafts/{draftId}/choose-model",
  "/api/v1/model-admin/models",
  "/api/v1/model-admin/models/validate",
  "/api/v1/model-admin/models/{modelKey}",
  "/api/v1/model-admin/models/{modelKey}/retire",
  "/api/v1/model-admin/contracts/active",
  "/api/v1/model-admin/contracts/{contractId}",
];
for (const path of requiredPaths) {
  if (!document.paths?.[path]) throw new Error(`Core Kernel OpenAPI missing ${path}`);
}

const retiredCompatibility = [
  "/api/v1/me/families",
  "/api/v1/families",
  "/api/v1/family-invites",
];
for (const path of Object.keys(document.paths ?? {})) {
  if (retiredCompatibility.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
    throw new Error(`Retired HomeMew compatibility path remains in Kernel OpenAPI: ${path}`);
  }
}

const ordinaryModelPrefixes = [
  "/api/v1/spaces/{spaceId}/events",
  "/api/v1/spaces/{spaceId}/tasks",
  "/api/v1/spaces/{spaceId}/day-records",
  "/api/v1/spaces/{spaceId}/wishes",
];
for (const path of Object.keys(document.paths ?? {})) {
  if (ordinaryModelPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
    throw new Error(`Ordinary model path leaked into Kernel OpenAPI instead of mct_*: ${path}`);
  }
  if (path.includes("{modelRoute}") || path.includes("{recordId}") || path.includes("{actionKey}")) {
    throw new Error(`Generic/model route template leaked into Kernel OpenAPI instead of concrete mct_*: ${path}`);
  }
}

if (document.paths?.["/api/v1/spaces/{spaceId}/creation-drafts/{draftId}/choose-kind"]) {
  throw new Error("Hard-coded Creation Draft choose-kind route must not remain");
}

const schemas = document.components?.schemas ?? {};
for (const name of Object.keys(schemas)) {
  if (/^(Event|Task|DayRecord|Wish|CreationDraftEvent|CreationDraftTask|CreationDraftDayRecord|CreationDraftWish)/.test(name)) {
    throw new Error(`Ordinary-model schema leaked into Kernel OpenAPI: ${name}`);
  }
  if (name.startsWith("Legacy")) {
    throw new Error(`Retired compatibility schema remains in Kernel OpenAPI: ${name}`);
  }
}

const tagNames = (document.tags ?? []).map((tag) => tag?.name);
for (const forbidden of ["Events", "Tasks", "Day Records", "Wishes"]) {
  if (tagNames.includes(forbidden)) throw new Error(`Ordinary-model tag leaked into Kernel OpenAPI: ${forbidden}`);
}

if (JSON.stringify(schemas.SpaceRole?.enum) !== JSON.stringify(["owner", "admin", "editor", "viewer"])) {
  throw new Error("Space roles drifted");
}
if (!schemas.Space?.required?.includes("timezone") || !schemas.Space?.required?.includes("version") || !schemas.Space?.required?.includes("avatarUrl")) {
  throw new Error("Space must expose timezone, avatarUrl and version");
}
if (schemas.Space?.properties?.avatarKey) {
  throw new Error("R2 avatar keys must not become a public Space contract");
}
if (schemas.UpdateSpaceRequest?.required?.[0] !== "version" || schemas.UpdateSpaceRequest?.minProperties !== 2) {
  throw new Error("Space updates must use optimistic concurrency");
}
const avatarPut = document.paths?.["/api/v1/spaces/{spaceId}/avatar"]?.put;
if (!avatarPut?.requestBody?.content?.["multipart/form-data"]?.schema?.required?.includes("version")) {
  throw new Error("Space avatar replacement must use optimistic concurrency");
}
if (document.paths?.["/assets/spaces/{spaceId}/avatar"]?.get?.security?.length !== 0) {
  throw new Error("Stable Space avatar URL must be publicly readable without exposing the R2 key");
}

if (schemas.Invite?.properties?.token) {
  throw new Error("Stored/listed invites must not expose plaintext tokens");
}
const createInviteData = schemas.CreateInviteResponse?.properties?.data;
const tokenSchema = createInviteData?.allOf?.[1]?.properties?.token;
if (tokenSchema?.writeOnly !== true) {
  throw new Error("Invitation plaintext token must be one-time/write-only");
}
if (schemas.JoinInviteRequest?.additionalProperties !== false || !schemas.JoinInviteRequest?.required?.includes("displayName")) {
  throw new Error("Invitation join must create/reactivate a Space Person");
}

if (document.components?.securitySchemes?.bearerAuth?.bearerFormat !== "JWT or lsp_pat_") {
  throw new Error("Core bearer contract must expose JWT and opaque service-token authentication");
}
if (!schemas.CreateDataGrantRequest?.properties?.granteeType?.enum && !schemas.GranteeType?.enum) {
  throw new Error("Data Grant grantee types are missing");
}
if (!schemas.GranteeType?.enum?.includes("service")) {
  throw new Error("Data Grants must support service principals");
}
if (schemas.DataGrantResourceType?.enum?.join(",") !== "space,model") {
  throw new Error("Data Grants must expose whole-Space and model-collection resource types");
}
if (!schemas.DataGrant?.required?.includes("resourceType") || !schemas.DataGrant?.required?.includes("resourceId")) {
  throw new Error("Data Grant responses must expose their resource target");
}
if (!schemas.CreateDataGrantRequest?.properties?.resourceType || !schemas.CreateDataGrantRequest?.properties?.resourceId) {
  throw new Error("Data Grant creation must accept an explicit resource target");
}
const grants = document.paths?.["/api/v1/spaces/{spaceId}/grants"];
const grant = document.paths?.["/api/v1/spaces/{spaceId}/grants/{grantId}"];
if (!grants?.get || !grants?.post || !grant?.patch || !grant?.delete) {
  throw new Error("Data Grant management lifecycle is incomplete");
}
if (!grants.get.responses?.["200"]?.description?.includes("model-collection") || !grants.post.responses?.["201"]?.description?.includes("model-collection")) {
  throw new Error("Data Grant contract must document model-collection support");
}

const subscriptions = document.paths?.["/api/v1/event-subscriptions"];
const subscription = document.paths?.["/api/v1/event-subscriptions/{subscriptionId}"];
if (!subscriptions?.get || !subscriptions?.post || !subscription?.patch || !subscription?.delete) {
  throw new Error("Event subscription management lifecycle is incomplete");
}
if (schemas.DomainEventType?.enum?.join(",") !== "record.created,record.updated,record.deleted") {
  throw new Error("Domain event types drifted");
}
if (!schemas.CreateWebhookSubscriptionRequest?.required?.includes("modelKey") || !schemas.CreateWebhookSubscriptionRequest?.required?.includes("spaceId")) {
  throw new Error("Event subscription creation must target one Space and model");
}
const signingSecret = schemas.CreateWebhookSubscriptionResponse?.properties?.data?.allOf?.[1]?.properties?.signingSecret;
if (signingSecret?.writeOnly !== true) {
  throw new Error("Webhook signing secret must be documented as one-time/write-only");
}
if (!document.paths?.["/api/v1/event-subscriptions/{subscriptionId}/deliveries"]?.get
    || !document.paths?.["/api/v1/event-subscriptions/{subscriptionId}/test"]?.post) {
  throw new Error("Event subscription delivery diagnostics are incomplete");
}

const creationDraft = document.paths?.["/api/v1/spaces/{spaceId}/creation-drafts"]?.post;
if (!creationDraft?.description?.includes("active user Space member")) {
  throw new Error("Creation Drafts must document user-member-only access");
}
if (!creationDraft?.description?.includes("Model Contract Revision")) {
  throw new Error("Creation Drafts must document the pinned Model Contract Revision");
}
if (!schemas.ChooseCreationDraftModelRequest?.required?.includes("targetModelKey")) {
  throw new Error("Registry Creation Draft model choice is missing targetModelKey");
}
if (!schemas.CreationDraftProcessing?.required?.includes("modelContractRevision")) {
  throw new Error("Creation Draft jobs must expose their pinned Model Contract Revision");
}

const adminModels = document.paths?.["/api/v1/model-admin/models"];
if (!adminModels?.get?.description?.includes("Service-principal-only") || !adminModels?.post?.description?.includes("Service-principal-only")) {
  throw new Error("Model Admin must be documented as service-principal-only");
}
if (!document.paths?.["/api/v1/model-admin/contracts/active"]?.get) {
  throw new Error("Active Model Contract Revision read surface is missing");
}
if (schemas.ModelCompatibility?.enum?.join(",") !== "initial,compatible,breaking") {
  throw new Error("Model compatibility values drifted");
}
if (schemas.ModelContract?.properties?.id?.pattern !== "^mct_[a-f0-9]{64}$") {
  throw new Error("Model Contract revisions must be content-addressed mct_<sha256>");
}

if (schemas.StatusResponse?.properties?.data?.properties?.contractVersion?.const !== "0.14.0") {
  throw new Error("Core Kernel status contract version drifted");
}

console.log("Core Kernel OpenAPI contract sanity check passed");
