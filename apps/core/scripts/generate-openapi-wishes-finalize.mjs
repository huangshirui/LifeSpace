import fs from "node:fs";
import YAML from "yaml";

const url = new URL("../openapi.yaml", import.meta.url);
const document = YAML.parse(fs.readFileSync(url, "utf8"));

if (document.info?.version !== "0.6.0" && document.info?.version !== "0.7.0") {
  throw new Error(`Unexpected Core contract version: ${document.info?.version}`);
}

document.info.version = "0.7.0";
document.info.description = "Space ownership, membership, invitations, Data Grants, Space-owned events/tasks/day records/wishes and their people relations, and temporary HomeMew compatibility facades.";
document.tags ??= [];
if (!document.tags.some((tag) => tag?.name === "Wishes")) {
  const homeMewIndex = document.tags.findIndex((tag) => tag?.name === "HomeMew compatibility");
  document.tags.splice(homeMewIndex >= 0 ? homeMewIndex : document.tags.length, 0, { name: "Wishes" });
}

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const responseRef = (name) => ({ $ref: `#/components/responses/${name}` });
const jsonBody = (schema) => ({ required: true, content: { "application/json": { schema } } });
const jsonResponse = (description, schema) => ({ description, content: { "application/json": { schema } } });
const errors = {
  "400": responseRef("InvalidRequest"),
  "401": responseRef("Unauthorized"),
  "403": responseRef("Forbidden"),
  "404": responseRef("NotFound"),
  "409": responseRef("Conflict"),
};

const nativeListParameters = [
  { name: "status", in: "query", schema: { type: "string", default: "open,claimed,fulfilled", description: "Comma-separated open, claimed, fulfilled, or archived values." } },
  { name: "ownerPersonId", in: "query", schema: { type: "string", description: "Space Person ID or me" } },
  { name: "claimantPersonId", in: "query", schema: { type: "string", description: "Space Person ID or me" } },
  { name: "desiredFrom", in: "query", schema: { type: "string", format: "date" } },
  { name: "desiredTo", in: "query", schema: { type: "string", format: "date" } },
  { name: "sort", in: "query", schema: ref("WishSort") },
  { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 100 } },
  { name: "cursor", in: "query", schema: { type: "string" } },
];
const legacyListParameters = nativeListParameters.map((parameter) => {
  if (parameter.name === "ownerPersonId") return { name: "ownerUserId", in: "query", schema: { type: "string", description: "Legacy HomeMew user ID or me" } };
  if (parameter.name === "claimantPersonId") return { name: "claimantUserId", in: "query", schema: { type: "string", description: "Legacy HomeMew user ID or me" } };
  return parameter;
});

const nativeItemParameters = [refParameter("SpaceId"), refParameter("WishId")];
const legacyItemParameters = [refParameter("LegacyFamilyId"), refParameter("WishId")];
function refParameter(name) { return { $ref: `#/components/parameters/${name}` }; }

function actionPath({ legacy, action, description }) {
  const responseSchema = legacy ? "LegacyWishResponse" : "WishResponse";
  return {
    parameters: legacy ? legacyItemParameters : nativeItemParameters,
    post: {
      tags: legacy ? ["Wishes", "HomeMew compatibility"] : ["Wishes"],
      operationId: `${action}${legacy ? "FamilyWishCompat" : "SpaceWish"}`,
      requestBody: jsonBody(ref("WishActionRequest")),
      responses: {
        "200": jsonResponse(description, ref(responseSchema)),
        ...errors,
      },
    },
  };
}

document.paths["/api/v1/spaces/{spaceId}/wishes"] = {
  parameters: [refParameter("SpaceId")],
  get: {
    tags: ["Wishes"],
    operationId: "listSpaceWishes",
    description: "Lists non-deleted Space-owned wishes. By default archived wishes are excluded.",
    parameters: nativeListParameters,
    responses: {
      "200": jsonResponse("Wish page", ref("WishListResponse")),
      "400": responseRef("InvalidRequest"),
      "401": responseRef("Unauthorized"),
      "403": responseRef("Forbidden"),
    },
  },
  post: {
    tags: ["Wishes"],
    operationId: "createSpaceWish",
    requestBody: jsonBody(ref("CreateWishRequest")),
    responses: {
      "201": jsonResponse("Wish created with the current active Space Person as owner", ref("WishResponse")),
      "400": responseRef("InvalidRequest"),
      "401": responseRef("Unauthorized"),
      "403": responseRef("Forbidden"),
    },
  },
};
document.paths["/api/v1/spaces/{spaceId}/wishes/{wishId}"] = {
  parameters: nativeItemParameters,
  get: {
    tags: ["Wishes"], operationId: "getSpaceWish",
    responses: { "200": jsonResponse("Wish detail", ref("WishResponse")), "401": errors["401"], "403": errors["403"], "404": errors["404"] },
  },
  patch: {
    tags: ["Wishes"], operationId: "updateSpaceWish",
    description: "Only the owner may edit an active wish. Archived wishes are read-only until restored.",
    requestBody: jsonBody(ref("UpdateWishRequest")),
    responses: { "200": jsonResponse("Wish updated", ref("WishResponse")), ...errors },
  },
  delete: {
    tags: ["Wishes"], operationId: "deleteSpaceWish",
    parameters: [{ name: "version", in: "query", required: true, schema: { type: "integer", minimum: 1 } }],
    responses: { "204": { description: "Wish soft-deleted" }, "401": errors["401"], "403": errors["403"], "404": errors["404"], "409": errors["409"] },
  },
};
for (const [action, description] of Object.entries({
  claim: "Wish claimed by the current member",
  unclaim: "Wish released by the current claimant",
  fulfill: "Wish fulfilled by its owner or current claimant",
  reopen: "Fulfilled wish reopened by its owner",
  archive: "Wish archived by its owner while preserving lifecycle state",
  restore: "Archived wish restored by its owner; an inactive former claimant falls back to open",
})) {
  document.paths[`/api/v1/spaces/{spaceId}/wishes/{wishId}/${action}`] = actionPath({ legacy: false, action, description });
}

document.paths["/api/v1/families/{familyId}/wishes"] = {
  parameters: [refParameter("LegacyFamilyId")],
  get: {
    tags: ["Wishes", "HomeMew compatibility"],
    operationId: "listFamilyWishesCompat",
    description: "Temporary HomeMew response over native Space wishes and historical Space Person lifecycle references.",
    parameters: legacyListParameters,
    responses: {
      "200": jsonResponse("Legacy wish page", ref("LegacyWishListResponse")),
      "400": responseRef("InvalidRequest"),
      "401": responseRef("Unauthorized"),
      "403": responseRef("Forbidden"),
    },
  },
  post: {
    tags: ["Wishes", "HomeMew compatibility"],
    operationId: "createFamilyWishCompat",
    requestBody: jsonBody(ref("LegacyCreateWishRequest")),
    responses: {
      "201": jsonResponse("Legacy wish created", ref("LegacyWishResponse")),
      "400": responseRef("InvalidRequest"),
      "401": responseRef("Unauthorized"),
      "403": responseRef("Forbidden"),
    },
  },
};
document.paths["/api/v1/families/{familyId}/wishes/{wishId}"] = {
  parameters: legacyItemParameters,
  get: {
    tags: ["Wishes", "HomeMew compatibility"], operationId: "getFamilyWishCompat",
    responses: { "200": jsonResponse("Legacy wish detail", ref("LegacyWishResponse")), "401": errors["401"], "403": errors["403"], "404": errors["404"] },
  },
  patch: {
    tags: ["Wishes", "HomeMew compatibility"], operationId: "updateFamilyWishCompat",
    requestBody: jsonBody(ref("LegacyUpdateWishRequest")),
    responses: { "200": jsonResponse("Legacy wish updated", ref("LegacyWishResponse")), ...errors },
  },
  delete: {
    tags: ["Wishes", "HomeMew compatibility"], operationId: "deleteFamilyWishCompat",
    parameters: [{ name: "version", in: "query", required: true, schema: { type: "integer", minimum: 1 } }],
    responses: { "204": { description: "Legacy wish soft-deleted" }, "401": errors["401"], "403": errors["403"], "404": errors["404"], "409": errors["409"] },
  },
};
for (const [action, description] of Object.entries({
  claim: "Legacy wish claimed",
  unclaim: "Legacy wish released",
  fulfill: "Legacy wish fulfilled",
  reopen: "Legacy wish reopened",
  archive: "Legacy wish archived",
  restore: "Legacy wish restored",
})) {
  document.paths[`/api/v1/families/{familyId}/wishes/{wishId}/${action}`] = actionPath({ legacy: true, action, description });
}

const schemas = document.components.schemas;
document.components.parameters.WishId = { name: "wishId", in: "path", required: true, schema: { type: "string", pattern: "^wsh_" } };
schemas.WishStatus = { type: "string", enum: ["open", "claimed", "fulfilled", "archived"] };
schemas.WishSort = { type: "string", enum: ["default", "desired_asc", "created_desc", "updated_desc"], default: "default" };
schemas.WishPersonRef = {
  type: "object", additionalProperties: false, required: ["personId", "displayName"],
  description: "Historical wish people remain renderable even after the referenced Space Person is deactivated.",
  properties: { personId: { type: "string", pattern: "^per_" }, displayName: { type: "string" } },
};
schemas.LegacyWishPersonRef = {
  type: "object", additionalProperties: false, required: ["userId", "displayName", "avatarUrl"],
  description: "Historical HomeMew wish people remain visible after membership removal.",
  properties: { userId: { type: "string", pattern: "^usr_" }, displayName: { type: "string" }, avatarUrl: { type: "null", description: "Deferred until the R2 slice." } },
};
schemas.Wish = {
  type: "object", additionalProperties: false,
  required: ["id", "spaceId", "title", "description", "desiredDate", "status", "owner", "claimant", "claimedAt", "fulfilledBy", "fulfilledAt", "createdBy", "updatedBy", "version", "createdAt", "updatedAt"],
  properties: {
    id: { type: "string", pattern: "^wsh_" }, spaceId: { type: "string", pattern: "^spc_" },
    title: { type: "string", minLength: 1, maxLength: 100 }, description: { type: ["string", "null"], maxLength: 5000 }, desiredDate: { type: ["string", "null"], format: "date" },
    status: ref("WishStatus"), owner: ref("WishPersonRef"), claimant: { oneOf: [ref("WishPersonRef"), { type: "null" }] }, claimedAt: { type: ["string", "null"], format: "date-time" },
    fulfilledBy: { oneOf: [ref("WishPersonRef"), { type: "null" }] }, fulfilledAt: { type: ["string", "null"], format: "date-time" },
    createdBy: ref("ActorRef"), updatedBy: ref("ActorRef"), version: { type: "integer", minimum: 1 }, createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" },
  },
};
schemas.LegacyWish = {
  type: "object", additionalProperties: false,
  required: ["id", "familyId", "title", "description", "desiredDate", "status", "owner", "claimant", "claimedAt", "fulfilledBy", "fulfilledAt", "createdBy", "updatedBy", "version", "createdAt", "updatedAt"],
  properties: {
    id: { type: "string", pattern: "^wsh_" }, familyId: { type: "string", pattern: "^fam_" },
    title: { type: "string", minLength: 1, maxLength: 100 }, description: { type: ["string", "null"], maxLength: 5000 }, desiredDate: { type: ["string", "null"], format: "date" },
    status: ref("WishStatus"), owner: ref("LegacyWishPersonRef"), claimant: { oneOf: [ref("LegacyWishPersonRef"), { type: "null" }] }, claimedAt: { type: ["string", "null"], format: "date-time" },
    fulfilledBy: { oneOf: [ref("LegacyWishPersonRef"), { type: "null" }] }, fulfilledAt: { type: ["string", "null"], format: "date-time" },
    createdBy: ref("LegacyActorRef"), updatedBy: ref("LegacyActorRef"), version: { type: "integer", minimum: 1 }, createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" },
  },
};
const createProperties = {
  title: { type: "string", minLength: 1, maxLength: 100 },
  description: { type: ["string", "null"], maxLength: 5000 },
  desiredDate: { type: ["string", "null"], format: "date" },
};
schemas.CreateWishRequest = { type: "object", additionalProperties: false, required: ["title"], properties: createProperties };
schemas.LegacyCreateWishRequest = { type: "object", additionalProperties: false, required: ["title"], properties: structuredClone(createProperties) };
const updateProperties = { version: { type: "integer", minimum: 1 }, ...createProperties };
schemas.UpdateWishRequest = { type: "object", additionalProperties: false, required: ["version"], minProperties: 2, properties: updateProperties };
schemas.LegacyUpdateWishRequest = { type: "object", additionalProperties: false, required: ["version"], minProperties: 2, properties: structuredClone(updateProperties) };
schemas.WishActionRequest = { type: "object", additionalProperties: false, required: ["version"], properties: { version: { type: "integer", minimum: 1 } } };
schemas.WishResponse = { type: "object", required: ["data"], properties: { data: ref("Wish") } };
schemas.LegacyWishResponse = { type: "object", required: ["data"], properties: { data: ref("LegacyWish") } };
schemas.WishListResponse = { type: "object", required: ["data"], properties: { data: { type: "object", required: ["items", "nextCursor"], properties: { items: { type: "array", items: ref("Wish") }, nextCursor: { type: ["string", "null"] } } } } };
schemas.LegacyWishListResponse = { type: "object", required: ["data"], properties: { data: { type: "object", required: ["items", "nextCursor"], properties: { items: { type: "array", items: ref("LegacyWish") }, nextCursor: { type: ["string", "null"] } } } } };

const contractVersion = schemas.StatusResponse?.properties?.data?.properties?.contractVersion;
if (!contractVersion) throw new Error("StatusResponse contractVersion schema is missing");
contractVersion.const = "0.7.0";

fs.writeFileSync(url, YAML.stringify(document, { lineWidth: 0 }), "utf8");
console.log("Generated Core OpenAPI 0.7.0 Wishes contract");
