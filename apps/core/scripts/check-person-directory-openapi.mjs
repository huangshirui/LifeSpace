import fs from "node:fs";
import YAML from "yaml";

const document = YAML.parse(fs.readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8"));
const collection = document.paths?.["/api/v1/spaces/{spaceId}/people"];
const item = document.paths?.["/api/v1/spaces/{spaceId}/people/{personId}"];
const schemas = document.components?.schemas ?? {};

if (document.info?.version !== "0.47.0") {
  throw new Error("Person Directory requires Core Kernel 0.47.0");
}
if (!document.tags?.some((tag) => tag?.name === "Person Directory")) {
  throw new Error("Person Directory Kernel tag is missing");
}
if (collection?.get?.operationId !== "listSpacePeople"
    || collection?.post?.operationId !== "createSpacePerson"
    || item?.get?.operationId !== "getSpacePerson"
    || item?.patch?.operationId !== "updateSpacePerson"
    || item?.delete?.operationId !== "deleteSpacePerson") {
  throw new Error("Person Directory CRUD/search surface is incomplete");
}

const listParams = new Map((collection?.get?.parameters ?? []).map((entry) => [entry.name, entry]));
if (listParams.get("limit")?.schema?.default !== 50
    || listParams.get("limit")?.schema?.maximum !== 100
    || listParams.get("q")?.schema?.maxLength !== 100
    || !listParams.has("cursor")) {
  throw new Error("Person Directory list/search bounds drifted");
}

const person = schemas.SpacePerson;
if (!person?.required?.includes("displayName")
    || !person.required.includes("alternateNames")
    || !person.required.includes("linkedUser")
    || !person.required.includes("version")
    || person.properties?.linkedUser?.type !== "boolean"
    || person.properties?.linkedUserId
    || person.properties?.userId) {
  throw new Error("Person response must expose bounded directory facts without global User identity");
}
if (person.properties?.alternateNames?.maxItems !== 20
    || person.properties?.alternateNames?.items?.maxLength !== 100) {
  throw new Error("Person alternateNames must remain bounded to 20 names of at most 100 characters");
}
if (schemas.CreateSpacePersonRequest?.properties?.linkedUserId
    || schemas.CreateSpacePersonRequest?.properties?.userId) {
  throw new Error("Person Directory must never establish User linkage");
}
if (!schemas.UpdateSpacePersonRequest?.required?.includes("version")
    || schemas.UpdateSpacePersonRequest?.minProperties !== 2
    || schemas.UpdateSpacePersonRequest?.properties?.alternateNames?.maxItems !== 20) {
  throw new Error("Person update must use optimistic concurrency and atomic alternate-name replacement");
}
if (!schemas.DeleteSpacePersonRequest?.required?.includes("version")) {
  throw new Error("Person delete must use optimistic concurrency");
}

for (const operation of [collection.get, collection.post, item.get, item.patch, item.delete]) {
  const pathParameters = operation === collection.get || operation === collection.post
    ? collection.parameters
    : item.parameters;
  if (!pathParameters?.some((entry) => entry?.$ref === "#/components/parameters/DelegationId")) {
    throw new Error("Person Directory operations must advertise explicit Delegation selection");
  }
}

if (!item.patch?.description?.includes("does not implicitly preserve the old name")) {
  throw new Error("Person rename contract must keep old-name retention explicit rather than automatic");
}
if (!item.delete?.description?.includes("active ordinary record still references")) {
  throw new Error("Person deletion must document active-reference protection");
}

console.log("Core Person Directory OpenAPI contract sanity check passed");
