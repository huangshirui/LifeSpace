import fs from "node:fs";
import YAML from "yaml";

const document = YAML.parse(fs.readFileSync(new URL("../integration-eventing.openapi.yaml", import.meta.url), "utf8"));

if (document.openapi !== "3.1.0" || document.info?.version !== "0.3.0") {
  throw new Error("Integration/Eventing OpenAPI version metadata is invalid");
}
const lifecycleDescription = document.info?.description?.toLowerCase() ?? "";
if (!document.info?.title?.includes("Eventing") || !lifecycleDescription.includes("independently versioned")) {
  throw new Error("Integration/Eventing OpenAPI must identify its independent contract lifecycle");
}

const requiredPaths = [
  "/api/v1/webhook-endpoints",
  "/api/v1/webhook-endpoints/{endpointId}",
  "/api/v1/webhook-endpoints/{endpointId}/deliveries",
  "/api/v1/webhook-endpoints/{endpointId}/test",
  "/api/v1/event-subscriptions",
  "/api/v1/event-subscriptions/{subscriptionId}",
].sort();
const actualPaths = Object.keys(document.paths ?? {}).sort();
if (JSON.stringify(actualPaths) !== JSON.stringify(requiredPaths)) {
  throw new Error(`Integration/Eventing path ownership drifted: ${actualPaths.join(", ")}`);
}

const endpoints = document.paths?.["/api/v1/webhook-endpoints"];
const endpoint = document.paths?.["/api/v1/webhook-endpoints/{endpointId}"];
if (!endpoints?.get || !endpoints?.post || !endpoint?.patch || !endpoint?.delete) {
  throw new Error("Webhook Endpoint management lifecycle is incomplete");
}
if (!document.paths?.["/api/v1/webhook-endpoints/{endpointId}/deliveries"]?.get
    || !document.paths?.["/api/v1/webhook-endpoints/{endpointId}/test"]?.post) {
  throw new Error("Webhook Endpoint diagnostics/test lifecycle is incomplete");
}

const subscriptions = document.paths?.["/api/v1/event-subscriptions"];
const subscription = document.paths?.["/api/v1/event-subscriptions/{subscriptionId}"];
if (!subscriptions?.get || !subscriptions?.post || !subscription?.patch || !subscription?.delete) {
  throw new Error("Event Subscription filter lifecycle is incomplete");
}

const schemas = document.components?.schemas ?? {};
const endpointSecret = schemas.CreateWebhookEndpointResponse?.properties?.data?.allOf?.[1]?.properties?.signingSecret;
if (endpointSecret?.writeOnly !== true) {
  throw new Error("Webhook Endpoint signing secret must remain one-time/write-only");
}
if (schemas.WebhookEndpoint?.properties?.modelKey || schemas.WebhookEndpoint?.properties?.eventTypes) {
  throw new Error("Webhook Endpoint must own transport/signing only, not subscription filters");
}
if (schemas.DomainEventType?.enum?.join(",") !== "record.created,record.updated,record.deleted") {
  throw new Error("Domain event types drifted");
}
if (!schemas.CreateEventSubscriptionRequest?.required?.includes("endpointId")
    || !schemas.CreateEventSubscriptionRequest?.required?.includes("modelKey")) {
  throw new Error("Event Subscription creation must attach one model filter to one Endpoint");
}
if (schemas.CreateEventSubscriptionRequest?.properties?.webhookUrl
    || schemas.UpdateEventSubscriptionRequest?.properties?.rotateSigningSecret) {
  throw new Error("Event Subscription filters must not own Webhook transport/signing configuration");
}
if (!schemas.WebhookDelivery?.required?.includes("events")
    || !schemas.WebhookDelivery?.required?.includes("operationGroupId")
    || schemas.WebhookDelivery?.properties?.events?.items?.$ref !== "#/components/schemas/WebhookDeliveryEventReference") {
  throw new Error("Endpoint-level delivery diagnostics must expose authoritative delivery event references");
}

const referencePayload = schemas.DomainEventReferencePayload;
const batchReferencePayload = schemas.DomainEventBatchReferencePayload;
const deliveryPayload = schemas.DomainEventDeliveryPayload;
const expectedReferenceFields = ["id", "type", "spaceId", "modelKey", "recordId", "recordVersion", "changeId", "occurredAt"].sort();
if (referencePayload?.additionalProperties !== false
    || JSON.stringify([...(referencePayload?.required ?? [])].sort()) !== JSON.stringify(expectedReferenceFields)
    || JSON.stringify(Object.keys(referencePayload?.properties ?? {}).sort()) !== JSON.stringify(expectedReferenceFields)) {
  throw new Error("Outbound ordinary-record Webhook payload must remain reference-only");
}
for (const forbidden of ["record", "data", "actor", "principal", "applicationId", "delegationId", "changedFields"]) {
  if (referencePayload?.properties?.[forbidden]) {
    throw new Error(`Reference-only Webhook payload leaked ${forbidden}`);
  }
}
if (batchReferencePayload?.additionalProperties !== false
    || JSON.stringify([...(batchReferencePayload?.required ?? [])].sort()) !== JSON.stringify(["events", "operationGroupId"])
    || batchReferencePayload?.properties?.operationGroupId?.pattern !== "^opg_[A-Za-z0-9_-]+$"
    || batchReferencePayload?.properties?.events?.minItems !== 1
    || batchReferencePayload?.properties?.events?.maxItems !== 20
    || batchReferencePayload?.properties?.events?.items?.$ref !== "#/components/schemas/DomainEventReferencePayload"
    || JSON.stringify(deliveryPayload?.oneOf) !== JSON.stringify([
      { $ref: "#/components/schemas/DomainEventReferencePayload" },
      { $ref: "#/components/schemas/DomainEventBatchReferencePayload" },
    ])) {
  throw new Error("Explicit operation-group Webhook payload contract drifted");
}

const testPayload = schemas.WebhookEndpointTestPayload;
const expectedTestFields = ["id", "type", "endpointId", "spaceId", "subscriberServicePrincipalId", "occurredAt"].sort();
if (testPayload?.additionalProperties !== false
    || testPayload?.properties?.type?.const !== "endpoint.test"
    || JSON.stringify([...(testPayload?.required ?? [])].sort()) !== JSON.stringify(expectedTestFields)
    || JSON.stringify(Object.keys(testPayload?.properties ?? {}).sort()) !== JSON.stringify(expectedTestFields)) {
  throw new Error("endpoint.test payload contract drifted");
}

const recordWebhook = document.webhooks?.recordChange?.post;
const testWebhook = document.webhooks?.endpointTest?.post;
if (!recordWebhook || !testWebhook) throw new Error("Outbound Webhook contracts are missing");
if (!referencePayload?.properties?.changeId?.anyOf?.some((entry) => entry?.type === "null")) {
  throw new Error("Domain Event changeId must preserve explicit nullable legacy evidence");
}
if (recordWebhook.requestBody?.content?.["application/json"]?.schema?.$ref !== "#/components/schemas/DomainEventDeliveryPayload") {
  throw new Error("recordChange Webhook must use the canonical single-or-operation-group reference payload");
}
if (testWebhook.requestBody?.content?.["application/json"]?.schema?.$ref !== "#/components/schemas/WebhookEndpointTestPayload") {
  throw new Error("endpointTest Webhook must use the canonical test payload");
}

function header(operation, name) {
  return operation.parameters?.find((parameter) => parameter?.in === "header" && parameter?.name === name);
}
for (const operation of [recordWebhook, testWebhook]) {
  if (header(operation, "X-LifeSpace-Timestamp")?.required !== true
      || header(operation, "X-LifeSpace-Signature")?.required !== true
      || !header(operation, "X-LifeSpace-Signature")?.description?.includes("timestamp + '.' + the exact raw UTF-8 request body")) {
    throw new Error("Webhook HMAC timestamp/signature contract drifted");
  }
}
for (const name of ["X-LifeSpace-Delivery-Id", "X-LifeSpace-Webhook-Endpoint-Id", "X-LifeSpace-Event-Count"]) {
  if (header(recordWebhook, name)?.required !== true) throw new Error(`recordChange Webhook missing required ${name}`);
}
for (const name of ["X-LifeSpace-Event-Id", "X-LifeSpace-Subscription-Id", "X-LifeSpace-Operation-Group-Id"]) {
  if (header(recordWebhook, name)?.required === true) throw new Error(`recordChange Webhook header ${name} must be conditional`);
}
if (header(testWebhook, "X-LifeSpace-Test")?.schema?.const !== "true") {
  throw new Error("endpoint.test Webhook must carry X-LifeSpace-Test: true");
}

const semantics = document["x-lifespace-delivery-semantics"];
if (semantics?.delivery !== "at-least-once"
    || semantics?.payloadMode !== "reference-only"
    || semantics?.callbackGrouping !== "explicit-operation-group-only"
    || semantics?.singleOperation !== "1 domain event -> 1 callback"
    || !semantics?.batchOperation?.includes("N domain events -> 1 callback")
    || !semantics?.independentOperations?.includes("no Core time-window coalescing")
    || semantics?.signatureAlgorithm !== "HMAC-SHA256"
    || semantics?.signatureInput !== "<X-LifeSpace-Timestamp>.<exact raw body>"
    || JSON.stringify(semantics?.idempotencyHeaders) !== JSON.stringify(["X-LifeSpace-Delivery-Id"])) {
  throw new Error("Integration/Eventing delivery semantics drifted");
}

if (document.components?.securitySchemes?.bearerAuth?.bearerFormat !== "JWT or lsp_pat_") {
  throw new Error("Integration/Eventing management APIs must use the existing Core bearer contract");
}

console.log("Integration/Eventing OpenAPI contract sanity check passed");
