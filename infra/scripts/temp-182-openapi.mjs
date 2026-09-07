import fs from "node:fs";

const path = new URL("../../apps/core/openapi.yaml", import.meta.url);
const document = JSON.parse(fs.readFileSync(path, "utf8"));
document.info.version = "0.27.0";
document.components.schemas.StatusResponse.properties.data.properties.contractVersion.const = "0.27.0";

document.paths["/api/v1/me/_discovery/inventory"] = {
  get: {
    tags: ["Me", "Runtime Discovery"],
    operationId: "getCurrentPrincipalRuntimeCapabilityInventory",
    description: "Returns a compact cross-Space current capability inventory for the authenticated principal. The response uses the same current visibility intersection as full current-principal Runtime Discovery (credential scopes, Application × Model Access, current Space membership/Data Grants, declared model access and current Agent Delegation when applicable), but de-duplicates coarse static model facts into one top-level models list and keeps per-Space entries as minimal model/access visibility edges. Heavy field/default/query/Action-input/Capability-binding semantics are intentionally omitted and can be loaded progressively through semanticDetailPathTemplate. This is a request-current capability preview, not authorization proof; execution rechecks all current authority and model/Capability rules.",
    responses: {
      "200": {
        description: "Compact current capability inventory with de-duplicated model facts and Space visibility edges",
        content: { "application/json": { schema: { $ref: "#/components/schemas/RuntimeDiscoveryInventoryResponse" } } },
      },
      "401": { $ref: "#/components/responses/Unauthorized" },
      "403": { $ref: "#/components/responses/Forbidden" },
    },
  },
};

const schemas = document.components.schemas;
schemas.RuntimeDiscoveryInventoryAction = {
  type: "object",
  additionalProperties: false,
  required: ["key", "access", "kind"],
  properties: {
    key: { type: "string", minLength: 1 },
    access: { $ref: "#/components/schemas/RuntimeDiscoveryAccess" },
    kind: { $ref: "#/components/schemas/RuntimeDiscoveryActionKind" },
  },
};
schemas.RuntimeDiscoveryInventoryModel = {
  type: "object",
  additionalProperties: false,
  required: ["key", "route", "version", "schemaHash", "display", "capabilities", "actions"],
  properties: {
    key: { type: "string", pattern: "^[a-z][a-z0-9_]{1,62}$" },
    route: { type: "string", pattern: "^[a-z][a-z0-9-]{1,62}$" },
    version: { type: "integer", minimum: 1 },
    schemaHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
    display: { $ref: "#/components/schemas/RuntimeDiscoveryDisplay" },
    capabilities: { type: "array", uniqueItems: true, items: { type: "string" } },
    actions: { type: "array", items: { $ref: "#/components/schemas/RuntimeDiscoveryInventoryAction" } },
  },
};
schemas.RuntimeDiscoveryInventoryModelEdge = {
  type: "object",
  additionalProperties: false,
  required: ["modelKey", "access"],
  properties: {
    modelKey: { type: "string", pattern: "^[a-z][a-z0-9_]{1,62}$" },
    access: { type: "array", minItems: 1, uniqueItems: true, items: { $ref: "#/components/schemas/RuntimeDiscoveryAccess" } },
  },
};
schemas.RuntimeDiscoveryInventorySpace = {
  type: "object",
  additionalProperties: false,
  required: ["spaceId", "spaceName", "models"],
  properties: {
    spaceId: { type: "string", pattern: "^spc_" },
    spaceName: {
      type: "string",
      minLength: 1,
      maxLength: 100,
      description: "Current human-readable label for this already-reachable Runtime Space reference; not Space-management authority.",
    },
    models: { type: "array", minItems: 1, items: { $ref: "#/components/schemas/RuntimeDiscoveryInventoryModelEdge" } },
  },
};
schemas.RuntimeDiscoveryInventoryResponse = {
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: {
    data: {
      type: "object",
      additionalProperties: false,
      required: ["semanticDetailPathTemplate", "models", "spaces"],
      properties: {
        semanticDetailPathTemplate: {
          const: "/api/v1/spaces/{spaceId}/_discovery/models/{modelKey}",
          description: "Path template for progressively loading the static semantic detail matching a visible model identity.",
        },
        models: { type: "array", items: { $ref: "#/components/schemas/RuntimeDiscoveryInventoryModel" } },
        spaces: { type: "array", items: { $ref: "#/components/schemas/RuntimeDiscoveryInventorySpace" } },
      },
    },
  },
};

fs.writeFileSync(path, JSON.stringify(document));
