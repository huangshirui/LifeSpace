import fs from "node:fs";
import YAML from "yaml";

const openapiUrl = new URL("../openapi.yaml", import.meta.url);
const document = YAML.parse(fs.readFileSync(openapiUrl, "utf8"));

document.info.version = "0.7.0";
document.info.description = "Space ownership, membership, invitations, Data Grants, Space-owned events/tasks/day records/wishes and their people relations, and temporary HomeMew compatibility facades.";
if (!document.tags.some((tag) => tag.name === "Wishes")) {
  const compatIndex = document.tags.findIndex((tag) => tag.name === "HomeMew compatibility");
  document.tags.splice(compatIndex < 0 ? document.tags.length : compatIndex, 0, { name: "Wishes" });
}

const response = (schema, description = "Success") => ({
  description,
  content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } },
});
const errorResponses = (conflict = false, notFound = false) => ({
  "400": { $ref: "#/components/responses/InvalidRequest" },
  "401": { $ref: "#/components/responses/Unauthorized" },
  "403": { $ref: "#/components/responses/Forbidden" },
  ...(notFound ? { "404": { $ref: "#/components/responses/NotFound" } } : {}),
  ...(conflict ? { "409": { $ref: "#/components/responses/Conflict" } } : {}),
});
const body = (schema) => ({ required: true, content: { "application/json": { schema: { $ref: `#/components/schemas/${schema}` } } } });
const actionPath = (legacy, action) => ({
  parameters: legacy
    ? [{ $ref: "#/components/parameters/LegacyFamilyId" }, { $ref: "#/components/parameters/WishId" }]
    : [{ $ref: "#/components/parameters/SpaceId" }, { $ref: "#/components/parameters/WishId" }],
  post: {
    tags: legacy ? ["Wishes", "HomeMew compatibility"] : ["Wishes"],
    operationId: `${action}${legacy ? "Family" : "Space"}Wish${legacy ? "Compat" : ""}`,
    description: "Wishes are member-participation records. Phase 2.6 lifecycle actions require an active linked user/Space Person in addition to Space authorization.",
    requestBody: body("WishActionRequest"),
    responses: { "200": response(legacy ? "LegacyWishResponse" : "WishResponse", `Wish ${action}ed`), ...errorResponses(true, true) },
  },
});

const nativeListParameters = [
  { name: "status", in: "query", schema: { type: "string", default: "open,claimed,fulfilled", description: "Comma-separated open, claimed, fulfilled, or archived values." } },
  { name: "ownerPersonId", in: "query", schema: { type: "string", description: "Space Person ID or me" } },
  { name: "claimantPersonId", in: "query", schema: { type: "string", description: "Space Person ID or me" } },
  { name: "desiredFrom", in: "query", schema: { type: "string", format: "date" } },
  { name: "desiredTo", in: "query", schema: { type: "string", format: "date" } },
  { name: "sort", in: "query", schema: { $ref: "#/components/schemas/WishSort" } },
  { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 100 } },
  { name: "cursor", in: "query", schema: { type: "string" } },
];
const legacyListParameters = nativeListParameters.map((parameter) => {
  if (parameter.name === "ownerPersonId") return { ...parameter, name: "ownerUserId", schema: { type: "string", description: "Legacy HomeMew user ID or me" } };
  if (parameter.name === "claimantPersonId") return { ...parameter, name: "claimantUserId", schema: { type: "string", description: "Legacy HomeMew user ID or me" } };
  return parameter;
});

document.paths["/api/v1/spaces/{spaceId}/wishes"] = {
  parameters: [{ $ref: "#/components/parameters/SpaceId" }],
  get: {
    tags: ["Wishes"], operationId: "listSpaceWishes",
    description: "Lists Space-owned wishes visible to an active member. Default status excludes archived wishes.",
    parameters: nativeListParameters,
    responses: { "200": response("WishListResponse", "Wish page"), ...errorResponses() },
  },
  post: {
    tags: ["Wishes"], operationId: "createSpaceWish",
    description: "Creates a wish owned by the current active Space Person.",
    requestBody: body("CreateWishRequest"),
    responses: { "201": response("WishResponse", "Wish created"), ...errorResponses() },
  },
};
document.paths["/api/v1/spaces/{spaceId}/wishes/{wishId}"] = {
  parameters: [{ $ref: "#/components/parameters/SpaceId" }, { $ref: "#/components/parameters/WishId" }],
  get: { tags: ["Wishes"], operationId: "getSpaceWish", responses: { "200": response("WishResponse", "Wish detail"), ...errorResponses(false, true) } },
  patch: {
    tags: ["Wishes"], operationId: "updateSpaceWish",
    description: "Only the current active owner may edit a non-archived wish.",
    requestBody: body("UpdateWishRequest"),
    responses: { "200": response("WishResponse", "Wish updated"), ...errorResponses(true, true) },
  },
  delete: {
    tags: ["Wishes"], operationId: "deleteSpaceWish",
    description: "Only the current active owner may soft-delete the wish.",
    parameters: [{ name: "version", in: "query", required: true, schema: { type: "integer", minimum: 1 } }],
    responses: { "204": { description: "Wish soft-deleted" }, ...errorResponses(true, true) },
  },
};
for (const action of ["claim", "unclaim", "fulfill", "reopen", "archive", "restore"]) {
  document.paths[`/api/v1/spaces/{spaceId}/wishes/{wishId}/${action}`] = actionPath(false, action);
}

document.paths["/api/v1/families/{familyId}/wishes"] = {
  parameters: [{ $ref: "#/components/parameters/LegacyFamilyId" }],
  get: {
    tags: ["Wishes", "HomeMew compatibility"], operationId: "listFamilyWishesCompat",
    description: "Temporary HomeMew response over the same native Space wishes and Space People.",
    parameters: legacyListParameters,
    responses: { "200": response("LegacyWishListResponse", "Legacy wish page"), ...errorResponses() },
  },
  post: {
    tags: ["Wishes", "HomeMew compatibility"], operationId: "createFamilyWishCompat",
    requestBody: body("LegacyCreateWishRequest"),
    responses: { "201": response("LegacyWishResponse", "Legacy wish created"), ...errorResponses() },
  },
};
document.paths["/api/v1/families/{familyId}/wishes/{wishId}"] = {
  parameters: [{ $ref: "#/components/parameters/LegacyFamilyId" }, { $ref: "#/components/parameters/WishId" }],
  get: { tags: ["Wishes", "HomeMew compatibility"], operationId: "getFamilyWishCompat", responses: { "200": response("LegacyWishResponse", "Legacy wish detail"), ...errorResponses(false, true) } },
  patch: {
    tags: ["Wishes", "HomeMew compatibility"], operationId: "updateFamilyWishCompat",
    requestBody: body("LegacyUpdateWishRequest"),
    responses: { "200": response("LegacyWishResponse", "Legacy wish updated"), ...errorResponses(true, true) },
  },
  delete: {
    tags: ["Wishes", "HomeMew compatibility"], operationId: "deleteFamilyWishCompat",
    parameters: [{ name: "version", in: "query", required: true, schema: { type: "integer", minimum: 1 } }],
    responses: { "204": { description: "Wish soft-deleted" }, ...errorResponses(true, true) },
  },
};
for (const action of ["claim", "unclaim", "fulfill", "reopen", "archive", "restore"]) {
  document.paths[`/api/v1/families/{familyId}/wishes/{wishId}/${action}`] = actionPath(true, action);
}

document.components.parameters.WishId = { name: "wishId", in: "path", required: true, schema: { type: "string", pattern: "^wsh_" } };
const schemas = document.components.schemas;
schemas.WishStatus = { type: "string", enum: ["open", "claimed", "fulfilled", "archived"] };
schemas.WishSort = { type: "string", enum: ["default", "desired_asc", "created_desc", "updated_desc"], default: "default" };
schemas.WishPersonRef = {
  type: "object", additionalProperties: false, required: ["personId", "displayName"],
  description: "Historical lifecycle people remain renderable after the referenced Space Person is deactivated.",
  properties: { personId: { type: "string", pattern: "^per_" }, displayName: { type: "string" } },
};
schemas.Wish = {
  type: "object", additionalProperties: false,
  required: ["id", "spaceId", "title", "description", "desiredDate", "status", "owner", "claimant", "claimedAt", "fulfilledBy", "fulfilledAt", "createdBy", "updatedBy", "version", "createdAt", "updatedAt"],
  properties: {
    id: { type: "string", pattern: "^wsh_" }, spaceId: { type: "string", pattern: "^spc_" },
    title: { type: "string", minLength: 1, maxLength: 100 }, description: { type: ["string", "null"], maxLength: 5000 },
    desiredDate: { type: ["string", "null"], format: "date" }, status: { $ref: "#/components/schemas/WishStatus" },
    owner: { $ref: "#/components/schemas/WishPersonRef" }, claimant: { oneOf: [{ $ref: "#/components/schemas/WishPersonRef" }, { type: "null" }] },
    claimedAt: { type: ["string", "null"], format: "date-time" }, fulfilledBy: { oneOf: [{ $ref: "#/components/schemas/WishPersonRef" }, { type: "null" }] },
    fulfilledAt: { type: ["string", "null"], format: "date-time" }, createdBy: { $ref: "#/components/schemas/ActorRef" }, updatedBy: { $ref: "#/components/schemas/ActorRef" },
    version: { type: "integer", minimum: 1 }, createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" },
  },
};
schemas.CreateWishRequest = {
  type: "object", additionalProperties: false, required: ["title"],
  properties: { title: { type: "string", minLength: 1, maxLength: 100 }, description: { type: ["string", "null"], maxLength: 5000 }, desiredDate: { type: ["string", "null"], format: "date" } },
};
schemas.UpdateWishRequest = {
  type: "object", additionalProperties: false, required: ["version"], minProperties: 2,
  properties: { version: { type: "integer", minimum: 1 }, title: { type: "string", minLength: 1, maxLength: 100 }, description: { type: ["string", "null"], maxLength: 5000 }, desiredDate: { type: ["string", "null"], format: "date" } },
};
schemas.WishActionRequest = { type: "object", additionalProperties: false, required: ["version"], properties: { version: { type: "integer", minimum: 1 } } };
schemas.WishResponse = { type: "object", required: ["data"], properties: { data: { $ref: "#/components/schemas/Wish" } } };
schemas.WishListResponse = {
  type: "object", required: ["data"], properties: { data: { type: "object", required: ["items", "nextCursor"], properties: { items: { type: "array", items: { $ref: "#/components/schemas/Wish" } }, nextCursor: { type: ["string", "null"] } } } },
};
schemas.LegacyWishPersonRef = {
  type: "object", additionalProperties: false, required: ["userId", "displayName", "avatarUrl"],
  description: "Historical HomeMew wish people remain visible after membership removal.",
  properties: { userId: { type: "string", pattern: "^usr_" }, displayName: { type: "string" }, avatarUrl: { type: "null", description: "Deferred until the R2 slice." } },
};
schemas.LegacyWish = {
  type: "object", additionalProperties: false,
  required: ["id", "familyId", "title", "description", "desiredDate", "status", "owner", "claimant", "claimedAt", "fulfilledBy", "fulfilledAt", "createdBy", "updatedBy", "version", "createdAt", "updatedAt"],
  properties: {
    id: { type: "string", pattern: "^wsh_" }, familyId: { type: "string", pattern: "^fam_" },
    title: { type: "string", minLength: 1, maxLength: 100 }, description: { type: ["string", "null"], maxLength: 5000 }, desiredDate: { type: ["string", "null"], format: "date" },
    status: { $ref: "#/components/schemas/WishStatus" }, owner: { $ref: "#/components/schemas/LegacyWishPersonRef" }, claimant: { oneOf: [{ $ref: "#/components/schemas/LegacyWishPersonRef" }, { type: "null" }] },
    claimedAt: { type: ["string", "null"], format: "date-time" }, fulfilledBy: { oneOf: [{ $ref: "#/components/schemas/LegacyWishPersonRef" }, { type: "null" }] }, fulfilledAt: { type: ["string", "null"], format: "date-time" },
    createdBy: { $ref: "#/components/schemas/LegacyActorRef" }, updatedBy: { $ref: "#/components/schemas/LegacyActorRef" }, version: { type: "integer", minimum: 1 },
    createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" },
  },
};
schemas.LegacyCreateWishRequest = structuredClone(schemas.CreateWishRequest);
schemas.LegacyUpdateWishRequest = structuredClone(schemas.UpdateWishRequest);
schemas.LegacyWishResponse = { type: "object", required: ["data"], properties: { data: { $ref: "#/components/schemas/LegacyWish" } } };
schemas.LegacyWishListResponse = {
  type: "object", required: ["data"], properties: { data: { type: "object", required: ["items", "nextCursor"], properties: { items: { type: "array", items: { $ref: "#/components/schemas/LegacyWish" } }, nextCursor: { type: ["string", "null"] } } } },
};
schemas.StatusResponse.properties.data.properties.contractVersion.const = "0.7.0";

const output = YAML.stringify(document, { lineWidth: 0 });
fs.writeFileSync(openapiUrl, output);
console.log(`GENERATED_OPENAPI_BASE64=${Buffer.from(output, "utf8").toString("base64")}`);
