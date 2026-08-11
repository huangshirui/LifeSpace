import fs from "node:fs";
import YAML from "yaml";

const document = YAML.parse(fs.readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8"));
if (document.openapi !== "3.1.0" || document.info?.version !== "0.8.0") throw new Error("Core OpenAPI version metadata is invalid");

const requiredPaths = [
  "/health",
  "/api/v1/status",
  "/api/v1/me",
  "/api/v1/me/spaces",
  "/api/v1/spaces",
  "/api/v1/spaces/{spaceId}",
  "/api/v1/spaces/{spaceId}/members",
  "/api/v1/spaces/{spaceId}/members/{userId}",
  "/api/v1/spaces/{spaceId}/leave",
  "/api/v1/spaces/{spaceId}/invites",
  "/api/v1/spaces/{spaceId}/invites/{inviteId}/revoke",
  "/api/v1/space-invites/{token}",
  "/api/v1/space-invites/{token}/join",
  "/api/v1/spaces/{spaceId}/events",
  "/api/v1/spaces/{spaceId}/events/{eventId}",
  "/api/v1/spaces/{spaceId}/tasks",
  "/api/v1/spaces/{spaceId}/tasks/{taskId}",
  "/api/v1/spaces/{spaceId}/tasks/{taskId}/complete",
  "/api/v1/spaces/{spaceId}/tasks/{taskId}/reopen",
  "/api/v1/spaces/{spaceId}/day-records",
  "/api/v1/spaces/{spaceId}/day-records/{dayRecordId}",
  "/api/v1/spaces/{spaceId}/day-records/{dayRecordId}/archive",
  "/api/v1/spaces/{spaceId}/day-records/{dayRecordId}/restore",
  "/api/v1/spaces/{spaceId}/day-records/{dayRecordId}/occurrences",
  "/api/v1/spaces/{spaceId}/wishes",
  "/api/v1/spaces/{spaceId}/wishes/{wishId}",
  "/api/v1/spaces/{spaceId}/wishes/{wishId}/claim",
  "/api/v1/spaces/{spaceId}/wishes/{wishId}/unclaim",
  "/api/v1/spaces/{spaceId}/wishes/{wishId}/fulfill",
  "/api/v1/spaces/{spaceId}/wishes/{wishId}/reopen",
  "/api/v1/spaces/{spaceId}/wishes/{wishId}/archive",
  "/api/v1/spaces/{spaceId}/wishes/{wishId}/restore",
  "/api/v1/spaces/{spaceId}/grants",
];
for (const path of requiredPaths) if (!document.paths?.[path]) throw new Error(`Core OpenAPI missing ${path}`);

for (const path of Object.keys(document.paths ?? {})) {
  if (path === "/api/v1/me/families" || path.startsWith("/api/v1/families") || path.startsWith("/api/v1/family-invites")) {
    throw new Error(`Retired HomeMew compatibility path remains in canonical OpenAPI: ${path}`);
  }
}

const schemas = document.components?.schemas ?? {};
for (const name of Object.keys(schemas)) {
  if (name.startsWith("Legacy")) throw new Error(`Retired HomeMew compatibility schema remains in canonical OpenAPI: ${name}`);
}

if (JSON.stringify(schemas.SpaceRole?.enum) !== JSON.stringify(["owner", "admin", "editor", "viewer"])) throw new Error("Space roles drifted");
if (!schemas.Space?.required?.includes("timezone") || !schemas.Space?.required?.includes("version")) throw new Error("Space must expose timezone and version");
if (schemas.UpdateSpaceRequest?.required?.[0] !== "version" || schemas.UpdateSpaceRequest?.minProperties !== 2) throw new Error("Space updates must use optimistic concurrency");
if (schemas.CreateInviteResponse?.properties?.data?.allOf?.[1]?.properties?.token?.writeOnly !== true) throw new Error("Invitation plaintext token must be one-time/write-only");
if (schemas.Invite?.properties?.token) throw new Error("Stored/listed invites must not expose plaintext tokens");
if (schemas.JoinInviteRequest?.additionalProperties !== false || !schemas.JoinInviteRequest?.required?.includes("displayName")) throw new Error("Invitation join must create/reactivate a Space Person");

if (!schemas.EventCommon?.required?.includes("spaceId") || schemas.EventCommon?.properties?.familyId) throw new Error("Native events must be Space-owned");
if (!schemas.CreateEventCommon?.properties?.attendeePersonIds || schemas.CreateEventCommon?.properties?.attendeeIds) throw new Error("Native attendees must reference Space People");
if (schemas.UpdateEventRequest?.required?.[0] !== "version" || schemas.UpdateEventRequest?.minProperties !== 2) throw new Error("Native event updates must use optimistic concurrency");

if (JSON.stringify(schemas.TaskStatus?.enum) !== JSON.stringify(["pending", "completed", "cancelled"])) throw new Error("Task statuses drifted");
if (!schemas.Task?.required?.includes("spaceId") || schemas.Task?.properties?.familyId) throw new Error("Native tasks must be Space-owned");
if (!schemas.CreateTaskRequest?.properties?.assigneePersonIds || schemas.CreateTaskRequest?.properties?.assigneeIds) throw new Error("Native task assignees must reference Space People");
if (schemas.UpdateTaskRequest?.required?.[0] !== "version" || schemas.UpdateTaskRequest?.minProperties !== 2) throw new Error("Native task updates must use optimistic concurrency");
const nativeIncludeNoDue = document.paths?.["/api/v1/spaces/{spaceId}/tasks"]?.get?.parameters?.find((parameter) => parameter?.name === "includeNoDue");
if (nativeIncludeNoDue?.schema?.default !== false) throw new Error("Native task includeNoDue omission behavior must be explicit");

if (JSON.stringify(schemas.DayRecordKind?.enum) !== JSON.stringify(["elapsed", "countdown", "cycle"])) throw new Error("Day record kinds drifted");
if (JSON.stringify(schemas.DayRecordStatus?.enum) !== JSON.stringify(["active", "archived"])) throw new Error("Day record statuses drifted");
if (!schemas.DayRecordCommon?.required?.includes("spaceId") || schemas.DayRecordCommon?.properties?.familyId) throw new Error("Native day records must be Space-owned");
if (!schemas.CreateDayRecordCommon?.properties?.subjectPersonId || schemas.CreateDayRecordCommon?.properties?.subjectUserId) throw new Error("Native day-record subjects must reference Space People");
if (schemas.UpdateDayRecordRequest?.required?.[0] !== "version" || schemas.UpdateDayRecordRequest?.minProperties !== 2) throw new Error("Native day-record updates must use optimistic concurrency");
if (!schemas.CreateDayRecordOccurrenceRequest?.required?.includes("occurredOn") || !schemas.CreateDayRecordOccurrenceRequest?.required?.includes("version")) throw new Error("Day-record occurrences must advance by date under optimistic concurrency");
if (schemas.DayRecordComputedBase?.additionalProperties === false) throw new Error("Day record computed base must allow allOf-derived computed fields");
for (const schemaName of ["CreateElapsedDayRecordRequest", "CreateCountdownDayRecordRequest", "CreateCycleDayRecordRequest"]) {
  if (schemas[schemaName]?.allOf?.[1]?.additionalProperties === false) throw new Error(`${schemaName} must allow fields evaluated by its allOf common schema`);
}
if (document.paths?.["/api/v1/spaces/{spaceId}/day-records/{dayRecordId}/occurrences"]?.post?.responses?.["201"] === undefined) throw new Error("Native occurrence creation must return 201");

if (JSON.stringify(schemas.WishStatus?.enum) !== JSON.stringify(["open", "claimed", "fulfilled", "archived"])) throw new Error("Wish statuses drifted");
if (!schemas.Wish?.required?.includes("spaceId") || schemas.Wish?.properties?.familyId) throw new Error("Native wishes must be Space-owned");
if (!schemas.Wish?.properties?.owner || !schemas.Wish?.properties?.claimant || !schemas.Wish?.properties?.fulfilledBy) throw new Error("Native wish lifecycle people are missing");
if (schemas.WishPersonRef?.properties?.userId || !schemas.WishPersonRef?.properties?.personId) throw new Error("Native wish people must use Space Person IDs");
if (schemas.UpdateWishRequest?.required?.[0] !== "version" || schemas.UpdateWishRequest?.minProperties !== 2) throw new Error("Native wish updates must use optimistic concurrency");
for (const action of ["claim", "unclaim", "fulfill", "reopen", "archive", "restore"]) {
  if (document.paths?.[`/api/v1/spaces/{spaceId}/wishes/{wishId}/${action}`]?.post?.responses?.["200"] === undefined) throw new Error(`Native wish ${action} must return 200`);
}

if (schemas.StatusResponse?.properties?.data?.properties?.contractVersion?.const !== "0.8.0") throw new Error("Core status contract version drifted");

console.log("Core OpenAPI native-only contract sanity check passed");
