import fs from "node:fs";
import YAML from "yaml";

const target = new URL("../openapi.yaml", import.meta.url);
const document = YAML.parse(fs.readFileSync(target, "utf8"));

document.info.version = "0.14.0";
document.info.description = `Stable LifeSpace Core Kernel contract for Space, membership, invitations, Data Grants, event subscriptions, model administration, assets and Registry-driven Creation Draft orchestration. Ordinary business-model routes are intentionally not declared here; each published Model Registry state produces an immutable Model Contract Revision (mct_<sha256>) containing its concrete CRUD/query/action/Capability OpenAPI and JSON Schema.`;

if (!document.tags.some((tag) => tag?.name === "Event Subscriptions")) {
  const index = document.tags.findIndex((tag) => tag?.name === "Creation Drafts");
  document.tags.splice(index < 0 ? document.tags.length : index, 0, { name: "Event Subscriptions" });
}

document.components.parameters.EventSubscriptionId = {
  name: "subscriptionId",
  in: "path",
  required: true,
  schema: { type: "string", pattern: "^sub_[A-Za-z0-9_-]+$" },
};

document.components.schemas.DomainEventType = {
  type: "string",
  enum: ["record.created", "record.updated", "record.deleted"],
};

document.components.schemas.WebhookSubscriptionDestination = {
  type: "object",
  additionalProperties: false,
  required: ["type", "url"],
  properties: {
    type: { type: "string", const: "webhook" },
    url: { type: "string", format: "uri" },
  },
};

document.components.schemas.WebhookSubscription = {
  type: "object",
  additionalProperties: false,
  required: ["id", "spaceId", "name", "modelKey", "eventTypes", "destination", "enabled", "signingConfigured", "createdAt", "updatedAt"],
  properties: {
    id: { type: "string", pattern: "^sub_[A-Za-z0-9_-]+$" },
    spaceId: { type: "string" },
    name: { type: "string", minLength: 1, maxLength: 80 },
    modelKey: { type: "string" },
    eventTypes: { type: "array", minItems: 1, uniqueItems: true, items: { $ref: "#/components/schemas/DomainEventType" } },
    destination: { $ref: "#/components/schemas/WebhookSubscriptionDestination" },
    enabled: { type: "boolean" },
    signingConfigured: { type: "boolean", const: true },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
};

document.components.schemas.CreateWebhookSubscriptionRequest = {
  type: "object",
  additionalProperties: false,
  required: ["spaceId", "name", "modelKey", "eventTypes", "webhookUrl"],
  properties: {
    spaceId: { type: "string" },
    name: { type: "string", minLength: 1, maxLength: 80 },
    modelKey: { type: "string" },
    eventTypes: { type: "array", minItems: 1, uniqueItems: true, items: { $ref: "#/components/schemas/DomainEventType" } },
    webhookUrl: { type: "string", format: "uri", description: "Public HTTPS Webhook destination." },
  },
};

document.components.schemas.UpdateWebhookSubscriptionRequest = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 80 },
    eventTypes: { type: "array", minItems: 1, uniqueItems: true, items: { $ref: "#/components/schemas/DomainEventType" } },
    webhookUrl: { type: "string", format: "uri" },
    enabled: { type: "boolean" },
    rotateSigningSecret: { type: "boolean" },
  },
};

document.components.schemas.WebhookSubscriptionResponse = {
  type: "object",
  required: ["data"],
  properties: { data: { $ref: "#/components/schemas/WebhookSubscription" } },
};

document.components.schemas.CreateWebhookSubscriptionResponse = {
  type: "object",
  required: ["data"],
  properties: {
    data: {
      allOf: [
        { $ref: "#/components/schemas/WebhookSubscription" },
        {
          type: "object",
          required: ["signingSecret", "signature"],
          properties: {
            signingSecret: { type: "string", minLength: 64, writeOnly: true, description: "Returned only on creation or explicit rotation." },
            signature: { type: "string" },
          },
        },
      ],
    },
  },
};

document.components.schemas.WebhookSubscriptionListResponse = {
  type: "object",
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["items"],
      properties: { items: { type: "array", items: { $ref: "#/components/schemas/WebhookSubscription" } } },
    },
  },
};

document.components.schemas.WebhookDelivery = {
  type: "object",
  additionalProperties: false,
  required: ["id", "eventId", "eventType", "recordId", "recordVersion", "occurredAt", "status", "attemptCount", "createdAt"],
  properties: {
    id: { type: "string" },
    eventId: { type: "string", pattern: "^evt_[A-Za-z0-9_-]+$" },
    eventType: { $ref: "#/components/schemas/DomainEventType" },
    recordId: { type: "string" },
    recordVersion: { type: "integer", minimum: 1 },
    occurredAt: { type: "string", format: "date-time" },
    status: { type: "string", enum: ["pending", "queued", "succeeded", "failed", "cancelled"] },
    attemptCount: { type: "integer", minimum: 0 },
    queuedAt: { type: ["string", "null"], format: "date-time" },
    deliveredAt: { type: ["string", "null"], format: "date-time" },
    lastStatusCode: { type: ["integer", "null"] },
    lastError: { type: ["string", "null"] },
    createdAt: { type: "string", format: "date-time" },
  },
};

document.components.schemas.WebhookDeliveryListResponse = {
  type: "object",
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["items"],
      properties: { items: { type: "array", items: { $ref: "#/components/schemas/WebhookDelivery" } } },
    },
  },
};

document.components.schemas.WebhookTestResponse = {
  type: "object",
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["ok", "statusCode"],
      properties: { ok: { type: "boolean" }, statusCode: { type: "integer", minimum: 100, maximum: 599 } },
    },
  },
};

const authErrors = {
  "401": { $ref: "#/components/responses/Unauthorized" },
  "403": { $ref: "#/components/responses/Forbidden" },
};

document.paths["/api/v1/event-subscriptions"] = {
  get: {
    tags: ["Event Subscriptions"],
    operationId: "listEventSubscriptions",
    description: "Lists subscriptions owned by the authenticated application context for one Space. Requires a user principal with `spaces:manage` and current Space manage permission.",
    parameters: [{ name: "spaceId", in: "query", required: true, schema: { type: "string" } }],
    responses: {
      "200": { description: "Event subscriptions", content: { "application/json": { schema: { $ref: "#/components/schemas/WebhookSubscriptionListResponse" } } } },
      ...authErrors,
    },
  },
  post: {
    tags: ["Event Subscriptions"],
    operationId: "createEventSubscription",
    description: "Creates a Space/model-scoped reference-only Webhook subscription. Requires `spaces:manage`, Space manage permission and current read access to the selected published model.",
    requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CreateWebhookSubscriptionRequest" } } } },
    responses: {
      "201": { description: "Subscription created; signing secret is returned only in this response.", content: { "application/json": { schema: { $ref: "#/components/schemas/CreateWebhookSubscriptionResponse" } } } },
      ...authErrors,
    },
  },
};

document.paths["/api/v1/event-subscriptions/{subscriptionId}"] = {
  parameters: [{ $ref: "#/components/parameters/EventSubscriptionId" }],
  patch: {
    tags: ["Event Subscriptions"],
    operationId: "updateEventSubscription",
    requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/UpdateWebhookSubscriptionRequest" } } } },
    responses: {
      "200": { description: "Subscription updated; a rotated signing secret is returned only when explicitly requested.", content: { "application/json": { schema: { $ref: "#/components/schemas/WebhookSubscriptionResponse" } } } },
      ...authErrors,
      "404": { $ref: "#/components/responses/NotFound" },
    },
  },
  delete: {
    tags: ["Event Subscriptions"],
    operationId: "deleteEventSubscription",
    responses: {
      "204": { description: "Subscription deleted" },
      ...authErrors,
      "404": { $ref: "#/components/responses/NotFound" },
    },
  },
};

document.paths["/api/v1/event-subscriptions/{subscriptionId}/deliveries"] = {
  parameters: [{ $ref: "#/components/parameters/EventSubscriptionId" }],
  get: {
    tags: ["Event Subscriptions"],
    operationId: "listEventSubscriptionDeliveries",
    description: "Returns up to the 50 most recent delivery attempts for the subscription.",
    responses: {
      "200": { description: "Recent deliveries", content: { "application/json": { schema: { $ref: "#/components/schemas/WebhookDeliveryListResponse" } } } },
      ...authErrors,
      "404": { $ref: "#/components/responses/NotFound" },
    },
  },
};

document.paths["/api/v1/event-subscriptions/{subscriptionId}/test"] = {
  parameters: [{ $ref: "#/components/parameters/EventSubscriptionId" }],
  post: {
    tags: ["Event Subscriptions"],
    operationId: "testEventSubscription",
    description: "Sends a signed `subscription.test` payload directly to the configured Webhook without creating a domain event.",
    responses: {
      "200": { description: "Webhook test result", content: { "application/json": { schema: { $ref: "#/components/schemas/WebhookTestResponse" } } } },
      ...authErrors,
      "404": { $ref: "#/components/responses/NotFound" },
      "502": { description: "Webhook transport failed" },
    },
  },
};

const paths = document.paths;
const ordered = {};
for (const [key, value] of Object.entries(paths)) {
  if (key.startsWith("/api/v1/event-subscriptions")) continue;
  ordered[key] = value;
  if (key === "/api/v1/spaces/{spaceId}/grants/{grantId}") {
    for (const eventPath of [
      "/api/v1/event-subscriptions",
      "/api/v1/event-subscriptions/{subscriptionId}",
      "/api/v1/event-subscriptions/{subscriptionId}/deliveries",
      "/api/v1/event-subscriptions/{subscriptionId}/test",
    ]) ordered[eventPath] = paths[eventPath];
  }
}
document.paths = ordered;

fs.writeFileSync(target, YAML.stringify(document, { lineWidth: 120 }), "utf8");
