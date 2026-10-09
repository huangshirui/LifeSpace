import fs from "node:fs";
import YAML from "yaml";

const document = YAML.parse(fs.readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8"));
const collection = document.paths?.["/api/v1/spaces/{spaceId}/people"];
const item = document.paths?.["/api/v1/spaces/{spaceId}/people/{personId}"];
const schemas = document.components?.schemas ?? {};

if (document.info?.version !== "0.49.0") {
  throw new Error("Person Directory requires Core Kernel 0.49.0");
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

const update = schemas.UpdateSpacePersonRequest;
const mutation = schemas.AlternateNameMutation;
const rename = schemas.AlternateNameRename;
if (!update?.required?.includes("version")
    || update.minProperties !== 2
    || update.properties?.alternateNames?.$ref !== "#/components/schemas/AlternateNameMutation") {
  throw new Error("Person update must use optimistic concurrency and the canonical alternate-name mutation object");
}
for (const key of ["set", "add", "remove"]) {
  if (mutation?.properties?.[key]?.maxItems !== 20
      || mutation.properties[key]?.items?.maxLength !== 100) {
    throw new Error(`alternateNames.${key} must remain bounded to 20 names of at most 100 characters`);
  }
}
if (mutation?.properties?.rename?.maxItems !== 20
    || mutation.properties.rename?.items?.$ref !== "#/components/schemas/AlternateNameRename"
    || !rename?.required?.includes("from")
    || !rename.required.includes("to")) {
  throw new Error("alternateNames.rename contract drifted");
}
if (!Array.isArray(mutation?.oneOf) || mutation.oneOf.length !== 2) {
  throw new Error("alternateNames.set must remain mutually exclusive with incremental operations");
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

if (!item.patch?.description?.includes("incremental add/remove/rename")
    || !item.patch.description.includes("does not implicitly preserve the old name")) {
  throw new Error("Person alternate-name mutation and rename semantics must remain explicit");
}
if (!item.delete?.description?.includes("active ordinary record still references")) {
  throw new Error("Person deletion must document active-reference protection");
}

console.log("Core Person Directory OpenAPI contract sanity check passed");
