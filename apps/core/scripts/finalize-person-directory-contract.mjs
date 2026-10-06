import { createHash } from "node:crypto";
import fs from "node:fs";

const openapiUrl = new URL("../openapi.yaml", import.meta.url);
const checkOpenapiUrl = new URL("./check-openapi.mjs", import.meta.url);
const contractStabilityBaselineUrl = new URL("../../../docs/contract-stability-baseline.json", import.meta.url);

const document = JSON.parse(fs.readFileSync(openapiUrl, "utf8"));
document.info.version = "0.47.0";
if (!document.info.description.includes("Kernel 0.47.0")) {
  document.info.description += " Kernel 0.47.0 adds the first-class Space Person Directory with canonical display names, bounded alternate-name lookup and incremental mutation, optimistic concurrency, governed Person changes and explicit current Space-target Delegation support for represented execution.";
}

document.tags ??= [];
if (!document.tags.some((tag) => tag?.name === "Person Directory")) {
  document.tags.push({ name: "Person Directory" });
}

document.components.parameters.PersonId = {
  name: "personId",
  in: "path",
  required: true,
  schema: { type: "string", pattern: "^per_[A-Za-z0-9_-]+$", maxLength: 200 },
};

const errorResponses = {
  "400": { $ref: "#/components/responses/InvalidRequest" },
  "401": { $ref: "#/components/responses/Unauthorized" },
  "403": { $ref: "#/components/responses/Forbidden" },
  "404": { $ref: "#/components/responses/NotFound" },
  "409": { $ref: "#/components/responses/Conflict" },
  "422": { $ref: "#/components/responses/ValidationError" },
};

const alternateNameArray = (description) => ({
  type: "array",
  maxItems: 20,
  uniqueItems: true,
  items: { type: "string", minLength: 1, maxLength: 100 },
  description,
});

document.components.schemas.SpacePerson = {
  type: "object",
  additionalProperties: false,
  required: ["id", "displayName", "alternateNames", "linkedUser", "version", "createdAt", "updatedAt"],
  properties: {
    id: { type: "string", pattern: "^per_[A-Za-z0-9_-]+$" },
    displayName: { type: "string", minLength: 1, maxLength: 100, description: "Canonical same-Space display/reference label." },
    alternateNames: alternateNameArray("Active alternate lookup names for this Space Person."),
    linkedUser: { type: "boolean", description: "Whether Membership lifecycle currently owns a global User linkage. The global usr_* identifier is intentionally not exposed." },
    version: { type: "integer", minimum: 1 },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
};
document.components.schemas.SpacePersonResponse = {
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: { data: { $ref: "#/components/schemas/SpacePerson" } },
};
document.components.schemas.SpacePersonPage = {
  type: "object",
  additionalProperties: false,
  required: ["items", "nextCursor"],
  properties: {
    items: { type: "array", items: { $ref: "#/components/schemas/SpacePerson" } },
    nextCursor: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
};
document.components.schemas.SpacePersonListResponse = {
  type: "object",
  additionalProperties: false,
  required: ["data"],
  properties: { data: { $ref: "#/components/schemas/SpacePersonPage" } },
};
document.components.schemas.CreateSpacePersonRequest = {
  type: "object",
  additionalProperties: false,
  required: ["displayName"],
  properties: {
    displayName: { type: "string", minLength: 1, maxLength: 100 },
    alternateNames: alternateNameArray("Initial alternate lookup names for the new Space Person."),
  },
};
document.components.schemas.AlternateNameRename = {
  type: "object",
  additionalProperties: false,
  required: ["from", "to"],
  properties: {
    from: { type: "string", minLength: 1, maxLength: 100 },
    to: { type: "string", minLength: 1, maxLength: 100 },
  },
};
document.components.schemas.AlternateNameMutation = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  description: "Mutates alternate names as part of one optimistic-concurrency Person update. set replaces the complete active set and is mutually exclusive with add/remove/rename. add, remove and rename may be combined in one atomic mutation.",
  properties: {
    set: alternateNameArray("Complete replacement set. Mutually exclusive with add, remove and rename."),
    add: alternateNameArray("Names to add to the current active set."),
    remove: alternateNameArray("Currently active names to remove."),
    rename: {
      type: "array",
      maxItems: 20,
      items: { $ref: "#/components/schemas/AlternateNameRename" },
      description: "Currently active names to rename. from must exist and to must not collide with another active or concurrently mutated name.",
    },
  },
  oneOf: [
    {
      required: ["set"],
      not: { anyOf: [{ required: ["add"] }, { required: ["remove"] }, { required: ["rename"] }] },
    },
    {
      anyOf: [{ required: ["add"] }, { required: ["remove"] }, { required: ["rename"] }],
      not: { required: ["set"] },
    },
  ],
};
document.components.schemas.UpdateSpacePersonRequest = {
  type: "object",
  additionalProperties: false,
  minProperties: 2,
  required: ["version"],
  properties: {
    version: { type: "integer", minimum: 1 },
    displayName: { type: "string", minLength: 1, maxLength: 100 },
    alternateNames: { $ref: "#/components/schemas/AlternateNameMutation" },
  },
};
document.components.schemas.DeleteSpacePersonRequest = {
  type: "object",
  additionalProperties: false,
  required: ["version"],
  properties: { version: { type: "integer", minimum: 1 } },
};

document.paths["/api/v1/spaces/{spaceId}/people"] = {
  parameters: [
    { $ref: "#/components/parameters/SpaceId" },
    { $ref: "#/components/parameters/DelegationId" },
  ],
  get: {
    tags: ["Person Directory"],
    operationId: "listSpacePeople",
    description: "Lists active Space People in canonical display-name order. q performs Space-scoped substring matching against canonical displayName and active alternate names. Alternate-name matches still return the canonical displayName. This is Shared Reality lookup, not Membership administration.",
    parameters: [
      { name: "q", in: "query", required: false, schema: { type: "string", maxLength: 100 } },
      { name: "cursor", in: "query", required: false, schema: { type: "string" } },
      { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
    ],
    responses: {
      "200": { description: "Active Space Person page", content: { "application/json": { schema: { $ref: "#/components/schemas/SpacePersonListResponse" } } } },
      ...errorResponses,
    },
  },
  post: {
    tags: ["Person Directory"],
    operationId: "createSpacePerson",
    description: "Creates an unlinked Space Person. Person Directory never accepts linkedUserId; User linkage is owned only by Membership/Invite lifecycle. Requires resources:write and current Space write Authority.",
    requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CreateSpacePersonRequest" } } } },
    responses: {
      "201": { description: "Space Person created", content: { "application/json": { schema: { $ref: "#/components/schemas/SpacePersonResponse" } } } },
      ...errorResponses,
    },
  },
};

document.paths["/api/v1/spaces/{spaceId}/people/{personId}"] = {
  parameters: [
    { $ref: "#/components/parameters/SpaceId" },
    { $ref: "#/components/parameters/PersonId" },
    { $ref: "#/components/parameters/DelegationId" },
  ],
  get: {
    tags: ["Person Directory"],
    operationId: "getSpacePerson",
    description: "Returns one active Space Person with canonical displayName, bounded alternateNames, linkedUser boundary fact and optimistic-concurrency version. Global usr_* identity is not exposed.",
    responses: {
      "200": { description: "Space Person", content: { "application/json": { schema: { $ref: "#/components/schemas/SpacePersonResponse" } } } },
      ...errorResponses,
    },
  },
  patch: {
    tags: ["Person Directory"],
    operationId: "updateSpacePerson",
    description: "Atomically updates the canonical displayName and/or alternate names under optimistic concurrency. alternateNames supports complete set replacement or incremental add/remove/rename without exposing aliases as independent resources. Changing displayName does not implicitly preserve the old name as an alternate name. A linked User may update their own Space Person with current read Authority; owner/admin may update linked Persons; other actors require current Space manage Authority for linked Persons.",
    requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/UpdateSpacePersonRequest" } } } },
    responses: {
      "200": { description: "Space Person updated", content: { "application/json": { schema: { $ref: "#/components/schemas/SpacePersonResponse" } } } },
      ...errorResponses,
    },
  },
  delete: {
    tags: ["Person Directory"],
    operationId: "deleteSpacePerson",
    description: "Soft-deletes an unlinked Space Person and its active alternate names under optimistic concurrency. Linked Persons are owned by Membership lifecycle and cannot be deleted here. Deletion is rejected while any active ordinary record still references the Person.",
    requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/DeleteSpacePersonRequest" } } } },
    responses: {
      "204": { description: "Space Person soft-deleted" },
      ...errorResponses,
    },
  },
};

document.components.schemas.StatusResponse.properties.data.properties.contractVersion.const = "0.47.0";
fs.writeFileSync(openapiUrl, JSON.stringify(document), "utf8");

let checkOpenapi = fs.readFileSync(checkOpenapiUrl, "utf8");
checkOpenapi = checkOpenapi.replace(
  'document.openapi !== "3.1.0" || document.info?.version !== "0.46.0"',
  'document.openapi !== "3.1.0" || document.info?.version !== "0.47.0"',
);
fs.writeFileSync(checkOpenapiUrl, checkOpenapi, "utf8");

const httpMethods = new Set(["get", "post", "put", "patch", "delete", "options", "head", "trace"]);
const coreOperations = [];
for (const [path, item] of Object.entries(document.paths ?? {})) {
  if (!item || typeof item !== "object" || Array.isArray(item)) continue;
  for (const method of Object.keys(item)) {
    if (httpMethods.has(method.toLowerCase())) coreOperations.push(`${method.toUpperCase()} ${path}`);
  }
}
const coreOperationSetSha256 = `sha256:${createHash("sha256")
  .update([...new Set(coreOperations)].sort().join("\n"))
  .digest("hex")}`;

const contractStabilityBaseline = JSON.parse(fs.readFileSync(contractStabilityBaselineUrl, "utf8"));
const coreKernel = contractStabilityBaseline.contractSources?.find((source) => source?.id === "core-kernel");
if (!coreKernel) throw new Error("contract-stability baseline is missing core-kernel");
coreKernel.groups ??= [];
const personDirectoryGroup = {
  id: "core-person-directory",
  maturity: "candidate",
  visibility: "public",
  operationPattern: "^(GET|POST) /api/v1/spaces/\\{spaceId\\}/people$|^(GET|PATCH|DELETE) /api/v1/spaces/\\{spaceId\\}/people/\\{personId\\}$",
};
const existingPersonDirectoryGroupIndex = coreKernel.groups.findIndex((group) => group?.id === personDirectoryGroup.id);
if (existingPersonDirectoryGroupIndex >= 0) {
  coreKernel.groups[existingPersonDirectoryGroupIndex] = personDirectoryGroup;
} else {
  coreKernel.groups.push(personDirectoryGroup);
}
coreKernel.operationSetSha256 = coreOperationSetSha256;
fs.writeFileSync(contractStabilityBaselineUrl, `${JSON.stringify(contractStabilityBaseline, null, 2)}\n`, "utf8");

function printChunks(label, text) {
  const encoded = Buffer.from(text, "utf8").toString("base64");
  const size = 4000;
  const count = Math.ceil(encoded.length / size);
  console.log(`${label}_CHUNK_COUNT=${count}`);
  for (let index = 0; index < count; index += 1) {
    console.log(`${label}_CHUNK_${String(index).padStart(3, "0")}=${encoded.slice(index * size, (index + 1) * size)}`);
  }
}

printChunks("PERSON_OPENAPI", fs.readFileSync(openapiUrl, "utf8"));
printChunks("PERSON_CHECK_OPENAPI", fs.readFileSync(checkOpenapiUrl, "utf8"));
printChunks("PERSON_CONTRACT_STABILITY_BASELINE", fs.readFileSync(contractStabilityBaselineUrl, "utf8"));
