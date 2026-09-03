import fs from "node:fs";
import YAML from "yaml";

const document = YAML.parse(fs.readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8"));

if (document.openapi !== "3.1.0" || document.info?.version !== "0.20.0") {
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
  "/api/v1/me/_discovery",
  "/api/v1/spaces",
  "/api/v1/spaces/{spaceId}",
  "/api/v1/spaces/{spaceId}/close",
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
  "/api/v1/spaces/{spaceId}/_discovery",
  "/api/v1/spaces/{spaceId}/agent-delegations",
  "/api/v1/spaces/{spaceId}/agent-delegations/{delegationId}",
  "/api/v1/spaces/{spaceId}/changes/{recordId}",
  "/api/v1/webhook-endpoints",
  "/api/v1/webhook-endpoints/{endpointId}",
  "/api/v1/webhook-endpoints/{endpointId}/deliveries",
  "/api/v1/webhook-endpoints/{endpointId}/test",
  "/api/v1/event-subscriptions",
  "/api/v1/event-subscriptions/{subscriptionId}",
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

if (document.paths?.["/api/v1/spaces/{spaceId}/members/{userId}"]?.delete?.responses?.["409"]?.$ref !== "#/components/responses/Conflict") {
  throw new Error("removeSpaceMember must preserve its 409 Conflict response");
}

for (const retired of [
  "/api/v1/event-subscriptions/{subscriptionId}/deliveries",
  "/api/v1/event-subscriptions/{subscriptionId}/test",
]) {
  if (document.paths?.[retired]) throw new Error(`Retired subscription-owned Webhook route remains: ${retired}`);
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
  if (path.includes("{modelRoute}") || path.includes("{actionKey}")) {
    throw new Error(`Generic/model route template leaked into Kernel OpenAPI instead of concrete mct_*: ${path}`);
  }
}

if (document.paths?.["/api/v1/spaces/{spaceId}/creation-drafts/{draftId}/choose-kind"]) {
  throw new Error("Hard-coded Creation Draft choose-kind route must not remain");
}

const schemas = document.components?.schemas ?? {};
for (const name of Object.keys(schemas)) {
  if (/^(Event|Task|DayRecord|Wish|CreationDraftEvent|CreationDraftTask|CreationDraftDayRecord|CreationDraftWish)/.test(name)
      && !name.startsWith("EventSubscription")) {
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
if (!tagNames.includes("Runtime Discovery")) {
  throw new Error("Runtime Discovery tag is missing from the Kernel contract");
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
const closeSpace = document.paths?.["/api/v1/spaces/{spaceId}/close"]?.post;
const closeSpaceSchema = closeSpace?.requestBody?.content?.["application/json"]?.schema;
if (!closeSpace?.description?.includes("current user membership role owner")
    || closeSpaceSchema?.additionalProperties !== false
    || !closeSpaceSchema?.required?.includes("version")) {
  throw new Error("Space close must be owner-only and use optimistic concurrency");
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

const discovery = document.paths?.["/api/v1/spaces/{spaceId}/_discovery"]?.get;
const aggregateDiscovery = document.paths?.["/api/v1/me/_discovery"]?.get;
if (!discovery?.description?.includes("capability preview") || !discovery?.description?.includes("execution")) {
  throw new Error("Runtime Discovery must be documented as a preview whose authority is rechecked at execution time");
}
if (!aggregateDiscovery?.description?.includes("cross-Space")
    || !aggregateDiscovery?.description?.includes("capability preview")
    || !aggregateDiscovery?.description?.includes("execution")) {
  throw new Error("Current-principal Runtime Discovery must document cross-Space preview and execution-time rechecks");
}
if (!discovery?.description?.includes("semantic/domain input")
    || !aggregateDiscovery?.description?.includes("semantic/domain input")) {
  throw new Error("Runtime Discovery must document semantic Action input separately from concurrency metadata");
}
if (aggregateDiscovery?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref !== "#/components/schemas/RuntimeDiscoveryAggregateResponse") {
  throw new Error("Current-principal Runtime Discovery must use its aggregate response schema");
}
if (schemas.RuntimeDiscoverySpace?.additionalProperties !== false
    || JSON.stringify(schemas.RuntimeDiscoverySpace?.required) !== JSON.stringify(["spaceId", "models"])
    || Object.keys(schemas.RuntimeDiscoverySpace?.properties ?? {}).some((key) => !["spaceId", "models"].includes(key))) {
  throw new Error("Cross-Space discovery must expose only Space identity and effective model metadata");
}
if (schemas.RuntimeDiscoveryAction?.additionalProperties !== false
    || !schemas.RuntimeDiscoveryAction?.required?.includes("input")
    || !schemas.RuntimeDiscoveryAction?.required?.includes("concurrency")) {
  throw new Error("Runtime Discovery actions must expose bounded semantic input and concurrency metadata");
}
if (schemas.RuntimeDiscoveryActionInput?.properties?.fields?.type !== "array"
    || schemas.RuntimeDiscoveryActionInput?.properties?.fields?.items?.$ref !== "#/components/schemas/RuntimeDiscoveryField") {
  throw new Error("Runtime Discovery action inputs must use bounded field metadata");
}
if (!schemas.RuntimeDiscoveryActionInput?.description?.includes("Semantic/domain inputs")
    || !schemas.RuntimeDiscoveryActionInput?.description?.includes("concurrency")) {
  throw new Error("Runtime Discovery action input must be explicitly semantic rather than technical mutation metadata");
}
const actionConcurrency = schemas.RuntimeDiscoveryAction?.properties?.concurrency;
if (actionConcurrency?.additionalProperties !== false
    || actionConcurrency?.properties?.strategy?.const !== "record-version"
    || actionConcurrency?.properties?.required?.const !== true
    || actionConcurrency?.properties?.transport?.additionalProperties !== false
    || actionConcurrency?.properties?.transport?.properties?.in?.const !== "body"
    || actionConcurrency?.properties?.transport?.properties?.name?.const !== "version") {
  throw new Error("Runtime Discovery record-version concurrency contract drifted");
}
if (!schemas.RuntimeDiscoveryFieldType?.enum?.includes("date")
    || !schemas.RuntimeDiscoveryFieldType?.enum?.includes("record_list")) {
  throw new Error("Runtime Discovery field type vocabulary drifted");
}
if (!schemas.RuntimeDiscoveryModel?.required?.includes("defaults")
    || schemas.RuntimeDiscoveryModel?.properties?.defaults?.type !== "object") {
  throw new Error("Runtime Discovery must expose authoritative model server defaults");
}

const endpoints = document.paths?.["/api/v1/webhook-endpoints"];
const endpoint = document.paths?.["/api/v1/webhook-endpoints/{endpointId}"];
if (!endpoints?.get || !endpoints?.post || !endpoint?.patch || !endpoint?.delete) {
  throw new Error("Webhook endpoint management lifecycle is incomplete");
}
const endpointSecret = schemas.CreateWebhookEndpointResponse?.properties?.data?.allOf?.[1]?.properties?.signingSecret;
if (endpointSecret?.writeOnly !== true) {
  throw new Error("Webhook endpoint signing secret must be one-time/write-only");
}
if (schemas.WebhookEndpoint?.properties?.modelKey || schemas.WebhookEndpoint?.properties?.eventTypes) {
  throw new Error("Webhook endpoint must own transport/signing only, not subscription filters");
}
if (!document.paths?.["/api/v1/webhook-endpoints/{endpointId}/deliveries"]?.get
    || !document.paths?.["/api/v1/webhook-endpoints/{endpointId}/test"]?.post) {
  throw new Error("Webhook endpoint diagnostics are incomplete");
}

const subscriptions = document.paths?.["/api/v1/event-subscriptions"];
const subscription = document.paths?.["/api/v1/event-subscriptions/{subscriptionId}"];
if (!subscriptions?.get || !subscriptions?.post || !subscription?.patch || !subscription?.delete) {
  throw new Error("Event subscription filter lifecycle is incomplete");
}
if (schemas.DomainEventType?.enum?.join(",") !== "record.created,record.updated,record.deleted") {
  throw new Error("Domain event types drifted");
}
if (!schemas.CreateEventSubscriptionRequest?.required?.includes("endpointId")
    || !schemas.CreateEventSubscriptionRequest?.required?.includes("modelKey")) {
  throw new Error("Event subscription creation must attach one model filter to one endpoint");
}
if (schemas.CreateEventSubscriptionRequest?.properties?.webhookUrl || schemas.UpdateEventSubscriptionRequest?.properties?.rotateSigningSecret) {
  throw new Error("Event subscription filters must not own Webhook transport/signing configuration");
}
if (!schemas.WebhookDelivery?.required?.includes("modelKey")) {
  throw new Error("Endpoint-level delivery diagnostics must identify the source model");
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

if (schemas.StatusResponse?.properties?.data?.properties?.contractVersion?.const !== "0.20.0") {
  throw new Error("Core Kernel status contract version drifted");
}

console.log("Core Kernel OpenAPI contract sanity check passed");

const agentDelegations = document.paths?.["/api/v1/spaces/{spaceId}/agent-delegations"];
if (!agentDelegations?.get || !agentDelegations?.post || !document.paths?.["/api/v1/spaces/{spaceId}/agent-delegations/{delegationId}"]?.delete) {
  throw new Error("Agent Delegation lifecycle is incomplete");
}
if (JSON.stringify(schemas.AgentDelegationModelAccess?.properties?.maxAccess?.enum) !== JSON.stringify(["read", "write", "manage"])) {
  throw new Error("Agent Delegation must use the stable read/write/manage ceiling");
}
if (!schemas.ResourceChangeActor?.properties?.type?.enum?.includes("agent") || !schemas.ResourceChange?.required?.includes("delegationId")) {
  throw new Error("Governed Change contract must preserve Agent actor and Delegation attribution");
}
