import fs from "node:fs";
import YAML from "yaml";

const document = YAML.parse(fs.readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8"));

if (document.openapi !== "3.1.0" || document.info?.version !== "0.31.0") {
  throw new Error("Core Kernel OpenAPI version metadata is invalid");
}
if (!document.info?.title?.includes("Kernel")) {
  throw new Error("Static Core OpenAPI must identify itself as the Kernel contract");
}
if (!document.info?.description?.includes("Model Contract Revision")) {
  throw new Error("Kernel OpenAPI must explain the separate immutable Model Contract surface");
}
if (!document.info?.description?.includes("Model Control Plane")) {
  throw new Error("Kernel OpenAPI must document the separate Model Control Plane contract");
}

const requiredPaths = [
  "/health",
  "/api/v1/status",
  "/assets/spaces/{spaceId}/avatar",
  "/api/v1/me",
  "/api/v1/me/spaces",
  "/api/v1/me/_discovery",
  "/api/v1/me/_discovery/inventory",
  "/api/v1/spaces",
  "/api/v1/spaces/{spaceId}",
  "/api/v1/spaces/{spaceId}/close",
  "/api/v1/spaces/{spaceId}/avatar",
  "/api/v1/spaces/{spaceId}/members",
  "/api/v1/spaces/{spaceId}/members/{userId}",
  "/api/v1/spaces/{spaceId}/leave",
  "/api/v1/spaces/{spaceId}/invites",
  "/api/v1/spaces/{spaceId}/invites/{inviteId}/revoke",
  "/api/v1/space-invites/preview",
  "/api/v1/space-invites/join",
  "/api/v1/spaces/{spaceId}/grants",
  "/api/v1/spaces/{spaceId}/grants/{grantId}",
  "/api/v1/spaces/{spaceId}/_discovery",
  "/api/v1/spaces/{spaceId}/_discovery/models/{modelKey}",
  "/api/v1/spaces/{spaceId}/_relation-targets/{modelKey}/{fieldKey}",
  "/api/v1/spaces/{spaceId}/_reference-resolutions/{modelKey}/{fieldKey}",
  "/api/v1/spaces/{spaceId}/agent-delegations",
  "/api/v1/spaces/{spaceId}/agent-delegations/{delegationId}",
  "/api/v1/spaces/{spaceId}/changes",
  "/api/v1/spaces/{spaceId}/changes/{recordId}",
  "/api/v1/spaces/{spaceId}/creation-drafts",
  "/api/v1/spaces/{spaceId}/creation-drafts/{draftId}",
  "/api/v1/spaces/{spaceId}/creation-drafts/{draftId}/choose-model",
];
for (const path of requiredPaths) {
  if (!document.paths?.[path]) throw new Error(`Core Kernel OpenAPI missing ${path}`);
}
for (const path of Object.keys(document.paths ?? {})) {
  if (path.startsWith("/api/v1/model-admin")) throw new Error(`Model Control Plane route leaked into Kernel OpenAPI: ${path}`);
  if (path === "/api/v1/webhook-endpoints" || path.startsWith("/api/v1/webhook-endpoints/")
      || path === "/api/v1/event-subscriptions" || path.startsWith("/api/v1/event-subscriptions/")) {
    throw new Error(`Integration/Eventing route leaked into Kernel OpenAPI: ${path}`);
  }
}
const canonicalChanges = document.paths?.["/api/v1/spaces/{spaceId}/changes"]?.get;
const legacyChanges = document.paths?.["/api/v1/spaces/{spaceId}/changes/{recordId}"]?.get;
const changeParams = new Map((canonicalChanges?.parameters ?? []).map((entry) => [entry.name, entry]));
if (canonicalChanges?.operationId !== "listRecordChangeHistory"
    || changeParams.get("recordId")?.required !== true
    || changeParams.get("limit")?.schema?.default !== 50
    || changeParams.get("limit")?.schema?.maximum !== 100
    || !changeParams.has("cursor")
    || canonicalChanges?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref !== "#/components/schemas/ResourceChangePageResponse") {
  throw new Error("Canonical Change History collection semantics drifted");
}
if (legacyChanges?.deprecated !== true
    || legacyChanges?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref !== "#/components/schemas/ResourceChangeListResponse") {
  throw new Error("Legacy Change History alias must remain explicitly deprecated and wire-compatible");
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
  if (name === "DomainEventType" || name.startsWith("Webhook") || name.startsWith("EventSubscription")) {
    throw new Error(`Integration/Eventing schema leaked into Kernel OpenAPI: ${name}`);
  }
  if (/^(Event|Task|DayRecord|Wish|CreationDraftEvent|CreationDraftTask|CreationDraftDayRecord|CreationDraftWish)/.test(name)) {
    throw new Error(`Ordinary-model schema leaked into Kernel OpenAPI: ${name}`);
  }
  if (name.startsWith("Legacy")) {
    throw new Error(`Retired compatibility schema remains in Kernel OpenAPI: ${name}`);
  }
}

const tagNames = (document.tags ?? []).map((tag) => tag?.name);
for (const forbidden of ["Events", "Tasks", "Day Records", "Wishes", "Webhook Endpoints", "Event Subscriptions"]) {
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
const previewInvite = document.paths?.["/api/v1/space-invites/preview"]?.post;
const joinInvite = document.paths?.["/api/v1/space-invites/join"]?.post;
if (document.paths?.["/api/v1/space-invites/{token}"] || document.paths?.["/api/v1/space-invites/{token}/join"]) {
  throw new Error("Invitation bearer tokens must not appear in API URL paths");
}
if (document.components?.parameters?.InviteToken) {
  throw new Error("Invitation bearer token must not remain a path parameter");
}
if (previewInvite?.requestBody?.content?.["application/json"]?.schema?.$ref !== "#/components/schemas/PreviewInviteRequest"
    || schemas.PreviewInviteRequest?.additionalProperties !== false
    || !schemas.PreviewInviteRequest?.required?.includes("token")) {
  throw new Error("Invitation preview must accept the possession token only through its bounded JSON body");
}
if (joinInvite?.requestBody?.content?.["application/json"]?.schema?.$ref !== "#/components/schemas/JoinInviteRequest"
    || schemas.JoinInviteRequest?.additionalProperties !== false
    || !schemas.JoinInviteRequest?.required?.includes("token")
    || !schemas.JoinInviteRequest?.required?.includes("displayName")) {
  throw new Error("Invitation join must accept token/displayName through its bounded JSON body and create/reactivate a Space Person");
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
const inventoryDiscovery = document.paths?.["/api/v1/me/_discovery/inventory"]?.get;
if (!discovery?.description?.includes("capability preview") || !discovery?.description?.includes("execution")) {
  throw new Error("Runtime Discovery must be documented as a preview whose authority is rechecked at execution time");
}
if (!aggregateDiscovery?.description?.includes("cross-Space")
    || !aggregateDiscovery?.description?.includes("spaceName")
    || !aggregateDiscovery?.description?.includes("capability preview")
    || !aggregateDiscovery?.description?.includes("execution")) {
  throw new Error("Current-principal Runtime Discovery must document cross-Space preview and execution-time rechecks");
}
if (!discovery?.description?.includes("spaceName")
    || !discovery?.description?.includes("semantic/domain input")
    || !aggregateDiscovery?.description?.includes("semantic/domain input")) {
  throw new Error("Runtime Discovery must document semantic Action input separately from concurrency metadata");
}
if (aggregateDiscovery?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref !== "#/components/schemas/RuntimeDiscoveryAggregateResponse") {
  throw new Error("Current-principal Runtime Discovery must use its aggregate response schema");
}
if (schemas.RuntimeDiscoverySpace?.additionalProperties !== false
    || JSON.stringify(schemas.RuntimeDiscoverySpace?.required) !== JSON.stringify(["spaceId", "spaceName", "models"])
    || schemas.RuntimeDiscoverySpace?.properties?.spaceName?.type !== "string"
    || schemas.RuntimeDiscoverySpace?.properties?.spaceName?.maxLength !== 100
    || Object.keys(schemas.RuntimeDiscoverySpace?.properties ?? {}).some((key) => !["spaceId", "spaceName", "models"].includes(key))) {
  throw new Error("Cross-Space discovery must expose only stable Space identity, minimal label and effective model metadata");
}
const singleDiscoveryData = schemas.RuntimeDiscoveryResponse?.properties?.data;
if (!singleDiscoveryData?.required?.includes("spaceName")
    || JSON.stringify(singleDiscoveryData?.properties?.spaceName?.type) !== JSON.stringify(["string", "null"])
    || singleDiscoveryData?.properties?.spaceName?.maxLength !== 100) {
  throw new Error("Single-Space discovery must expose a nullable bounded Space label without creating a Space-detail side channel");
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
if (schemas.RuntimeDiscoveryField?.properties?.title?.type !== "string"
    || schemas.RuntimeDiscoveryField?.properties?.title?.maxLength !== 80) {
  throw new Error("Runtime Discovery fields must expose bounded JSON Schema-aligned title metadata");
}
if (schemas.RuntimeDiscoveryField?.properties?.relation?.$ref !== "#/components/schemas/RuntimeDiscoveryRelation"
    || schemas.RuntimeDiscoveryRelation?.additionalProperties !== false
    || JSON.stringify(schemas.RuntimeDiscoveryRelation?.properties?.cardinality?.enum) !== JSON.stringify(["one", "many"])) {
  throw new Error("Runtime Discovery relation metadata must expose bounded target/cardinality semantics");
}
const referenceLabelSemantic = schemas.RuntimeReferenceLabelSemantic;
if (referenceLabelSemantic?.oneOf?.length !== 3
    || referenceLabelSemantic.oneOf[0]?.properties?.mode?.const !== "id"
    || referenceLabelSemantic.oneOf[1]?.properties?.mode?.const !== "field"
    || referenceLabelSemantic.oneOf[2]?.properties?.mode?.const !== "template"
    || referenceLabelSemantic.oneOf[2]?.properties?.fields?.maxItems !== 8
    || referenceLabelSemantic.oneOf[2]?.properties?.template?.maxLength !== 200) {
  throw new Error("Runtime reference-label semantic contract drifted");
}
for (const schemaName of ["RuntimeDiscoveryModel", "RuntimeModelSemanticDetail"]) {
  const schema = schemas[schemaName];
  if (!schema?.required?.includes("referenceLabel")
      || schema?.properties?.referenceLabel?.$ref !== "#/components/schemas/RuntimeReferenceLabelSemantic") {
    throw new Error(schemaName + " must expose canonical reference-label semantics");
  }
}
const referenceResolution = document.paths?.["/api/v1/spaces/{spaceId}/_reference-resolutions/{modelKey}/{fieldKey}"]?.post;
const referenceResolutionId = schemas.ReferenceResolutionRequest?.properties?.ids?.items;
if (referenceResolutionId?.pattern !== "^(?:per|rec)_[A-Za-z0-9_-]+$"
    || referenceResolutionId?.maxLength !== 200) {
  throw new Error("Reference Resolution must accept bounded Person and ordinary-record IDs according to the source relation kind");
}
if (referenceResolution?.requestBody?.content?.["application/json"]?.schema?.$ref !== "#/components/schemas/ReferenceResolutionRequest"
    || referenceResolution?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref !== "#/components/schemas/ReferenceResolutionResponse"
    || !referenceResolution?.description?.includes("opaque unavailable")
    || !referenceResolution?.description?.includes("never proves mutation authority")) {
  throw new Error("Reference Resolution must remain bounded, opaque and non-authoritative");
}
if (!referenceResolution?.description?.includes("record/record_list")
    || !referenceResolution?.description?.includes("target-model read authority")) {
  throw new Error("Reference Resolution must document canonical ordinary-record projection and target Model authority");
}
if (schemas.ReferenceResolutionRequest?.additionalProperties !== false
    || schemas.ReferenceResolutionRequest?.properties?.ids?.minItems !== 1
    || schemas.ReferenceResolutionRequest?.properties?.ids?.maxItems !== 50
    || schemas.RuntimeRelationResolutionSupported?.properties?.method?.const !== "POST"
    || schemas.RuntimeRelationResolutionSupported?.properties?.pathTemplate?.const !== "/api/v1/spaces/{spaceId}/_reference-resolutions/{modelKey}/{fieldKey}"
    || schemas.RuntimeRelationResolutionSupported?.properties?.maxIds?.const !== 50
    || schemas.RuntimeRelationResolutionUnsupported?.properties?.reason?.const !== "reference-label-unavailable") {
  throw new Error("Reference Resolution request/descriptor bounds drifted");
}
if (!schemas.RuntimeDiscoveryRelation?.required?.includes("resolution")
    || schemas.RuntimeDiscoveryRelation?.properties?.resolution?.oneOf?.length !== 2
    || !schemas.RuntimeModelSemanticRelation?.required?.includes("resolution")
    || schemas.RuntimeModelSemanticRelation?.properties?.resolution?.oneOf?.length !== 2) {
  throw new Error("Discovery and static semantic detail must expose Reference Resolution capability structurally");
}
if (schemas.ReferenceResolutionResolved?.properties?.status?.const !== "resolved"
    || schemas.ReferenceResolutionUnavailable?.properties?.status?.const !== "unavailable"
    || schemas.ReferenceResolutionUnavailable?.properties?.label) {
  throw new Error("Reference Resolution per-item opacity contract drifted");
}

const relationLookup = document.paths?.["/api/v1/spaces/{spaceId}/_relation-targets/{modelKey}/{fieldKey}"]?.get;
const relationLookupSupported = schemas.RuntimeDiscoveryRelationLookupSupported;
const relationLookupUnsupported = schemas.RuntimeDiscoveryRelationLookupUnsupported;
if (!relationLookup?.description?.includes("source-field-aware")
    || !relationLookup?.description?.includes("not proof of mutation authority")
    || relationLookup?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref !== "#/components/schemas/RelationTargetLookupResponse"
    || relationLookupSupported?.properties?.supported?.const !== true
    || relationLookupSupported?.properties?.method?.const !== "GET"
    || relationLookupSupported?.properties?.pathTemplate?.const !== "/api/v1/spaces/{spaceId}/_relation-targets/{modelKey}/{fieldKey}"
    || relationLookupSupported?.properties?.searchParameter?.const !== "q"
    || relationLookupSupported?.properties?.cursorParameter?.const !== "cursor"
    || relationLookupSupported?.properties?.limitParameter?.const !== "limit"
    || relationLookupUnsupported?.properties?.supported?.const !== false
    || relationLookupUnsupported?.properties?.reason?.const !== "reference-label-unavailable") {
  throw new Error("Relation target lookup contract drifted");
}
if (!relationLookup?.description?.includes("record/record_list")
    || !relationLookup?.description?.includes("target Model")) {
  throw new Error("Relation Target Lookup must document canonical ordinary-record projection and target Model authority");
}
if (schemas.RelationTarget?.additionalProperties !== false
    || JSON.stringify(schemas.RelationTarget?.required) !== JSON.stringify(["id", "label"])
    || schemas.RelationTargetPage?.properties?.items?.items?.$ref !== "#/components/schemas/RelationTarget") {
  throw new Error("Relation target projection must remain minimal id/label data");
}
const discoverySort = schemas.RuntimeDiscoveryQuery?.properties?.sort;
if (!schemas.RuntimeDiscoveryQuery?.required?.includes("sort")
    || discoverySort?.additionalProperties !== false
    || discoverySort?.properties?.parameter?.const !== "sort"
    || discoverySort?.properties?.syntax?.const !== "field:direction"
    || discoverySort?.properties?.repeatable?.const !== true
    || discoverySort?.properties?.ordered?.const !== true
    || discoverySort?.properties?.maxCriteria?.const !== 8
    || JSON.stringify(discoverySort?.properties?.default?.const) !== JSON.stringify(["createdAt:desc"])
    || JSON.stringify(discoverySort?.properties?.envelopeFields?.const) !== JSON.stringify(["createdAt", "updatedAt"])) {
  throw new Error("Runtime Discovery ordered Generic Query sort metadata drifted");
}
if (!schemas.RuntimeDiscoveryModel?.required?.includes("defaults")
    || schemas.RuntimeDiscoveryModel?.properties?.defaults?.type !== "object") {
  throw new Error("Runtime Discovery must expose authoritative model server defaults");
}
const capabilityBindings = schemas.RuntimeDiscoveryModel?.properties?.capabilityBindings;
const calendarBinding = schemas.RuntimeDiscoveryCalendarCapabilityBinding;
if (!schemas.RuntimeDiscoveryModel?.required?.includes("capabilityBindings")
    || capabilityBindings?.$ref !== "#/components/schemas/RuntimeDiscoveryCapabilityBindings"
    || schemas.RuntimeDiscoveryCapabilityBindings?.additionalProperties !== false
    || schemas.RuntimeDiscoveryCapabilityBindings?.properties?.calendar?.$ref !== "#/components/schemas/RuntimeDiscoveryCalendarCapabilityBinding"
    || schemas.RuntimeDiscoveryModel?.properties?.capabilities?.type !== "array") {
  throw new Error("Runtime Discovery Capability binding/inventory contract drifted");
}
const calendarRequired = [
  "allDayField", "timedStartField", "timedEndField", "startTimezoneField",
  "endTimezoneField", "allDayStartField", "allDayEndExclusiveField",
];
if (calendarBinding?.additionalProperties !== false
    || JSON.stringify(calendarBinding?.required) !== JSON.stringify(calendarRequired)
    || calendarRequired.some((key) => calendarBinding?.properties?.[key]?.pattern !== "^[a-z][A-Za-z0-9]{0,62}$")
    || calendarBinding?.properties?.attendeePersonField?.pattern !== "^[a-z][A-Za-z0-9]{0,62}$") {
  throw new Error("Runtime Discovery Calendar Capability field-role binding drifted");
}

const semanticDetailRoute = document.paths?.["/api/v1/spaces/{spaceId}/_discovery/models/{modelKey}"]?.get;
if (semanticDetailRoute?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref !== "#/components/schemas/RuntimeModelSemanticDetailResponse"
    || !semanticDetailRoute?.description?.includes("static semantic detail")
    || !semanticDetailRoute?.description?.includes("current visibility gate")
    || !semanticDetailRoute?.description?.includes("opaque 404")
    || !semanticDetailRoute?.description?.includes("execution")) {
  throw new Error("Single-model semantic detail must document progressive static projection and current authority gating");
}
if (JSON.stringify(Object.keys(semanticDetailRoute?.responses ?? {}).sort()) !== JSON.stringify(["200", "401", "404"])) {
  throw new Error("Single-model semantic detail must use one opaque 404 for missing and currently invisible models");
}
const semanticDetail = schemas.RuntimeModelSemanticDetail;
const semanticDetailProperties = Object.keys(semanticDetail?.properties ?? {}).sort();
const expectedSemanticDetailProperties = [
  "actions", "capabilities", "capabilityBindings", "declaredAccess", "defaults", "description", "display",
  "fields", "key", "query", "referenceLabel", "route", "schemaHash", "version",
].sort();
if (semanticDetail?.additionalProperties !== false
    || JSON.stringify(semanticDetailProperties) !== JSON.stringify(expectedSemanticDetailProperties)
    || !semanticDetail?.required?.includes("declaredAccess")
    || semanticDetail?.properties?.access
    || semanticDetail?.properties?.spaceId
    || semanticDetail?.properties?.spaceName) {
  throw new Error("Single-model semantic detail must expose only static model semantics without effective Space authority state");
}
if (schemas.RuntimeModelSemanticField?.properties?.relation?.$ref !== "#/components/schemas/RuntimeModelSemanticRelation"
    || Object.keys(schemas.RuntimeModelSemanticRelation?.properties ?? {}).sort().join(",") !== "cardinality,resolution,targetModel"
    || schemas.RuntimeModelSemanticRelation?.properties?.lookup) {
  throw new Error("Single-model semantic detail relation facts must remain static target/cardinality/resolution semantics without dynamic lookup state");
}
if (!schemas.RuntimeModelSemanticQuery?.required?.includes("filters")
    || !schemas.RuntimeModelSemanticQuery?.required?.includes("pagination")
    || !schemas.RuntimeModelSemanticQuery?.required?.includes("capabilityParameters")
    || schemas.RuntimeModelSemanticQuery?.properties?.sort?.properties?.nullPlacement?.const !== "last") {
  throw new Error("Single-model semantic detail must expose complete shared query facts");
}
if (!schemas.RuntimeModelSemanticAction?.required?.includes("invocation")
    || schemas.RuntimeModelSemanticAction?.properties?.concurrency?.$ref !== "#/components/schemas/RuntimeModelSemanticActionConcurrency") {
  throw new Error("Single-model semantic detail actions must expose shared invocation and concurrency facts");
}
if (schemas.RuntimeModelSemanticCapabilityBindings?.additionalProperties !== false
    || !schemas.RuntimeModelSemanticCapabilityBindings?.properties?.calendar
    || !schemas.RuntimeModelSemanticCapabilityBindings?.properties?.temporal) {
  throw new Error("Single-model semantic detail must expose registered Calendar and Temporal semantic bindings");
}

if (inventoryDiscovery?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref !== "#/components/schemas/RuntimeDiscoveryInventoryResponse"
    || !inventoryDiscovery?.description?.includes("compact cross-Space")
    || !inventoryDiscovery?.description?.includes("request-current capability preview")
    || !inventoryDiscovery?.description?.includes("execution")) {
  throw new Error("Compact current capability inventory must remain a request-current preview with execution-time rechecks");
}
const inventoryAction = schemas.RuntimeDiscoveryInventoryAction;
const inventoryModel = schemas.RuntimeDiscoveryInventoryModel;
const inventoryEdge = schemas.RuntimeDiscoveryInventoryModelEdge;
const inventorySpace = schemas.RuntimeDiscoveryInventorySpace;
const inventoryData = schemas.RuntimeDiscoveryInventoryResponse?.properties?.data;
const exactProperties = (schema, expected) => schema?.additionalProperties === false
  && JSON.stringify(Object.keys(schema?.properties ?? {}).sort()) === JSON.stringify([...expected].sort());
if (!exactProperties(inventoryAction, ["key", "access", "kind"])
    || inventoryAction?.properties?.input
    || inventoryAction?.properties?.concurrency) {
  throw new Error("Compact capability inventory actions must expose only coarse key/access/kind facts");
}
if (!exactProperties(inventoryModel, ["key", "route", "version", "schemaHash", "display", "capabilities", "actions"])
    || inventoryModel?.properties?.fields
    || inventoryModel?.properties?.defaults
    || inventoryModel?.properties?.query
    || inventoryModel?.properties?.capabilityBindings
    || inventoryModel?.properties?.access) {
  throw new Error("Compact capability inventory models must de-duplicate only coarse static model facts");
}
if (!exactProperties(inventoryEdge, ["modelKey", "access"])
    || !exactProperties(inventorySpace, ["spaceId", "spaceName", "models"])) {
  throw new Error("Compact capability inventory Space entries must remain minimal dynamic visibility edges");
}
if (inventoryData?.additionalProperties !== false
    || JSON.stringify(inventoryData?.required) !== JSON.stringify(["semanticDetailPathTemplate", "models", "spaces"])
    || inventoryData?.properties?.semanticDetailPathTemplate?.const !== "/api/v1/spaces/{spaceId}/_discovery/models/{modelKey}"
    || inventoryData?.properties?.models?.items?.$ref !== "#/components/schemas/RuntimeDiscoveryInventoryModel"
    || inventoryData?.properties?.spaces?.items?.$ref !== "#/components/schemas/RuntimeDiscoveryInventorySpace") {
  throw new Error("Compact capability inventory must point deterministically to progressive single-model semantic detail");
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

if (schemas.StatusResponse?.properties?.data?.properties?.contractVersion?.const !== "0.31.0") {
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