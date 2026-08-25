import fs from "node:fs";

const file = new URL("../openapi.yaml", import.meta.url);
const document = JSON.parse(fs.readFileSync(file, "utf8"));
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const responseRef = (name) => ({ $ref: `#/components/responses/${name}` });

const standardErrors = {
  "400": responseRef("InvalidRequest"),
  "401": responseRef("Unauthorized"),
  "403": responseRef("Forbidden"),
  "404": responseRef("NotFound"),
};

const jsonBody = (schemaName) => ({
  required: true,
  content: { "application/json": { schema: ref(schemaName) } },
});
const jsonResponse = (description, schemaName) => ({
  description,
  content: { "application/json": { schema: ref(schemaName) } },
});

// Kernel 0.15.0 makes transport/signing a reusable Webhook Endpoint resource.
document.info.version = "0.15.0";
document.info.description = document.info.description
  .replace("event subscriptions,", "webhook endpoints, event subscriptions,");
const tags = document.tags ?? [];
if (!tags.some((tag) => tag.name === "Webhook Endpoints")) {
  const eventIndex = tags.findIndex((tag) => tag.name === "Event Subscriptions");
  tags.splice(eventIndex >= 0 ? eventIndex : tags.length, 0, { name: "Webhook Endpoints" });
}
document.tags = tags;

const endpointParameter = { $ref: "#/components/parameters/WebhookEndpointId" };
const subscriptionParameter = { $ref: "#/components/parameters/EventSubscriptionId" };

document.paths["/api/v1/webhook-endpoints"] = {
  get: {
    tags: ["Webhook Endpoints"],
    operationId: "listWebhookEndpoints",
    description: "Lists Webhook endpoints owned by the authenticated application context for one Space, optionally filtered to one subscriber service principal. Requires a user principal with spaces:manage and current Space manage permission.",
    parameters: [
      { name: "spaceId", in: "query", required: true, schema: { type: "string" } },
      { name: "subscriberServicePrincipalId", in: "query", required: false, schema: { type: "string" } },
    ],
    responses: {
      "200": jsonResponse("Webhook endpoints", "WebhookEndpointListResponse"),
      "401": responseRef("Unauthorized"),
      "403": responseRef("Forbidden"),
    },
  },
  post: {
    tags: ["Webhook Endpoints"],
    operationId: "createWebhookEndpoint",
    description: "Creates a reusable signed Webhook destination for one Space and subscriber Service Principal. Subscriptions attach model/event filters to this endpoint; the endpoint itself grants no model data access.",
    requestBody: jsonBody("CreateWebhookEndpointRequest"),
    responses: {
      "201": jsonResponse("Webhook endpoint created; signing secret is returned only in this response.", "CreateWebhookEndpointResponse"),
      ...standardErrors,
    },
  },
};

document.paths["/api/v1/webhook-endpoints/{endpointId}"] = {
  parameters: [endpointParameter],
  patch: {
    tags: ["Webhook Endpoints"],
    operationId: "updateWebhookEndpoint",
    requestBody: jsonBody("UpdateWebhookEndpointRequest"),
    responses: {
      "200": jsonResponse("Webhook endpoint updated; a rotated signing secret is returned only when explicitly requested.", "UpdateWebhookEndpointResponse"),
      ...standardErrors,
    },
  },
  delete: {
    tags: ["Webhook Endpoints"],
    operationId: "deleteWebhookEndpoint",
    description: "Soft-deletes the endpoint and disables/deletes its active subscription filters.",
    responses: {
      "204": { description: "Webhook endpoint deleted" },
      "401": responseRef("Unauthorized"),
      "403": responseRef("Forbidden"),
      "404": responseRef("NotFound"),
    },
  },
};

document.paths["/api/v1/webhook-endpoints/{endpointId}/deliveries"] = {
  parameters: [endpointParameter],
  get: {
    tags: ["Webhook Endpoints"],
    operationId: "listWebhookEndpointDeliveries",
    description: "Returns up to the 50 most recent deliveries across all subscription filters attached to the endpoint.",
    responses: {
      "200": jsonResponse("Recent deliveries", "WebhookDeliveryListResponse"),
      "401": responseRef("Unauthorized"),
      "403": responseRef("Forbidden"),
      "404": responseRef("NotFound"),
    },
  },
};

document.paths["/api/v1/webhook-endpoints/{endpointId}/test"] = {
  parameters: [endpointParameter],
  post: {
    tags: ["Webhook Endpoints"],
    operationId: "testWebhookEndpoint",
    description: "Sends a signed endpoint.test payload directly to the configured Webhook without creating a domain event or reading model data.",
    responses: {
      "200": jsonResponse("Webhook test result", "WebhookTestResponse"),
      "401": responseRef("Unauthorized"),
      "403": responseRef("Forbidden"),
      "404": responseRef("NotFound"),
      "502": { description: "Webhook transport failed" },
    },
  },
};

document.paths["/api/v1/event-subscriptions"] = {
  get: {
    tags: ["Event Subscriptions"],
    operationId: "listEventSubscriptions",
    description: "Lists model/event filters attached to one owned Webhook endpoint.",
    parameters: [{ name: "endpointId", in: "query", required: true, schema: { type: "string", pattern: "^whk_" } }],
    responses: {
      "200": jsonResponse("Event subscriptions", "EventSubscriptionListResponse"),
      "401": responseRef("Unauthorized"),
      "403": responseRef("Forbidden"),
      "404": responseRef("NotFound"),
    },
  },
  post: {
    tags: ["Event Subscriptions"],
    operationId: "createEventSubscription",
    description: "Adds one Space/model event filter to an existing Webhook endpoint. Requires current model read access for the managing application and a current Data Grant that lets the endpoint subscriber Service Principal read the selected model.",
    requestBody: jsonBody("CreateEventSubscriptionRequest"),
    responses: {
      "201": jsonResponse("Event subscription created", "EventSubscriptionResponse"),
      ...standardErrors,
      "409": responseRef("Conflict"),
    },
  },
};

document.paths["/api/v1/event-subscriptions/{subscriptionId}"] = {
  parameters: [subscriptionParameter],
  patch: {
    tags: ["Event Subscriptions"],
    operationId: "updateEventSubscription",
    requestBody: jsonBody("UpdateEventSubscriptionRequest"),
    responses: {
      "200": jsonResponse("Event subscription updated", "EventSubscriptionResponse"),
      ...standardErrors,
    },
  },
  delete: {
    tags: ["Event Subscriptions"],
    operationId: "deleteEventSubscription",
    responses: {
      "204": { description: "Event subscription deleted" },
      "401": responseRef("Unauthorized"),
      "403": responseRef("Forbidden"),
      "404": responseRef("NotFound"),
    },
  },
};

delete document.paths["/api/v1/event-subscriptions/{subscriptionId}/deliveries"];
delete document.paths["/api/v1/event-subscriptions/{subscriptionId}/test"];

document.components.parameters.WebhookEndpointId = {
  name: "endpointId",
  in: "path",
  required: true,
  schema: { type: "string", pattern: "^whk_[A-Za-z0-9_-]+$" },
};

const schemas = document.components.schemas;
const eventTypes = {
  type: "array",
  minItems: 1,
  uniqueItems: true,
  items: ref("DomainEventType"),
};

schemas.WebhookDestination = {
  type: "object",
  additionalProperties: false,
  required: ["type", "url"],
  properties: {
    type: { type: "string", const: "webhook" },
    url: { type: "string", format: "uri" },
  },
};

schemas.WebhookEndpoint = {
  type: "object",
  additionalProperties: false,
  required: ["id", "spaceId", "subscriberServicePrincipalId", "name", "destination", "enabled", "signingConfigured", "createdAt", "updatedAt"],
  properties: {
    id: { type: "string", pattern: "^whk_[A-Za-z0-9_-]+$" },
    spaceId: { type: "string" },
    subscriberServicePrincipalId: {
      type: "string",
      minLength: 1,
      description: "Service Principal representing the external system that owns this Webhook endpoint.",
    },
    name: { type: "string", minLength: 1, maxLength: 80 },
    destination: ref("WebhookDestination"),
    enabled: { type: "boolean" },
    signingConfigured: { type: "boolean", const: true },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
};

schemas.CreateWebhookEndpointRequest = {
  type: "object",
  additionalProperties: false,
  required: ["spaceId", "subscriberServicePrincipalId", "name", "webhookUrl"],
  properties: {
    spaceId: { type: "string" },
    subscriberServicePrincipalId: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1, maxLength: 80 },
    webhookUrl: { type: "string", format: "uri", description: "Public HTTPS Webhook destination shared by all attached subscription filters." },
  },
};

schemas.UpdateWebhookEndpointRequest = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 80 },
    webhookUrl: { type: "string", format: "uri" },
    enabled: { type: "boolean" },
    rotateSigningSecret: { type: "boolean" },
  },
};

schemas.WebhookEndpointResponse = {
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: { data: ref("WebhookEndpoint") },
};

schemas.CreateWebhookEndpointResponse = {
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      allOf: [
        ref("WebhookEndpoint"),
        {
          type: "object",
          required: ["signingSecret", "signature"],
          properties: {
            signingSecret: { type: "string", minLength: 64, writeOnly: true, description: "Returned only when the endpoint is created." },
            signature: { type: "string" },
          },
        },
      ],
    },
  },
};

schemas.UpdateWebhookEndpointResponse = {
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      allOf: [
        ref("WebhookEndpoint"),
        {
          type: "object",
          properties: {
            signingSecret: { type: "string", minLength: 64, writeOnly: true, description: "Present only when rotateSigningSecret=true and returned once." },
          },
        },
      ],
    },
  },
};

schemas.WebhookEndpointListResponse = {
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["items"],
      properties: { items: { type: "array", items: ref("WebhookEndpoint") } },
    },
  },
};

schemas.EventSubscription = {
  type: "object",
  additionalProperties: false,
  required: ["id", "endpointId", "modelKey", "eventTypes", "enabled", "createdAt", "updatedAt"],
  properties: {
    id: { type: "string", pattern: "^sub_[A-Za-z0-9_-]+$" },
    endpointId: { type: "string", pattern: "^whk_[A-Za-z0-9_-]+$" },
    modelKey: { type: "string" },
    eventTypes,
    enabled: { type: "boolean" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
};

schemas.CreateEventSubscriptionRequest = {
  type: "object",
  additionalProperties: false,
  required: ["endpointId", "modelKey", "eventTypes"],
  properties: {
    endpointId: { type: "string", pattern: "^whk_[A-Za-z0-9_-]+$" },
    modelKey: { type: "string" },
    eventTypes,
  },
};

schemas.UpdateEventSubscriptionRequest = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    eventTypes,
    enabled: { type: "boolean" },
  },
};

schemas.EventSubscriptionResponse = {
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: { data: ref("EventSubscription") },
};

schemas.EventSubscriptionListResponse = {
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["items"],
      properties: { items: { type: "array", items: ref("EventSubscription") } },
    },
  },
};

for (const old of [
  "WebhookSubscriptionDestination",
  "WebhookSubscription",
  "CreateWebhookSubscriptionRequest",
  "UpdateWebhookSubscriptionRequest",
  "WebhookSubscriptionResponse",
  "CreateWebhookSubscriptionResponse",
  "UpdateWebhookSubscriptionResponse",
  "WebhookSubscriptionListResponse",
]) delete schemas[old];

if (!schemas.WebhookDelivery.required.includes("modelKey")) schemas.WebhookDelivery.required.splice(3, 0, "modelKey");
schemas.WebhookDelivery.properties.modelKey = { type: "string" };
schemas.StatusResponse.properties.data.properties.contractVersion.const = "0.15.0";

fs.writeFileSync(file, `${JSON.stringify(document)}\n`);
console.log("Patched Core Kernel OpenAPI to 0.15.0 webhook endpoint architecture");
