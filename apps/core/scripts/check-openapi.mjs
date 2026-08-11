import fs from "node:fs";
import YAML from "yaml";

const document = YAML.parse(fs.readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8"));
if (document.openapi !== "3.1.0" || document.info?.version !== "0.7.0") throw new Error("Core OpenAPI version metadata is invalid");

for (const path of [
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
  "/api/v1/me/families",
  "/api/v1/families",
  "/api/v1/families/{familyId}",
  "/api/v1/families/{familyId}/members",
  "/api/v1/families/{familyId}/members/{userId}",
  "/api/v1/families/{familyId}/leave",
  "/api/v1/families/{familyId}/invites",
  "/api/v1/families/{familyId}/invites/{inviteId}/revoke",
  "/api/v1/family-invites/{code}",
  "/api/v1/family-invites/{code}/join",
  "/api/v1/spaces/{spaceId}/events",
  "/api/v1/spaces/{spaceId}/events/{eventId}",
  "/api/v1/families/{familyId}/events",
  "/api/v1/families/{familyId}/events/{eventId}",
  "/api/v1/spaces/{spaceId}/tasks",
  "/api/v1/spaces/{spaceId}/tasks/{taskId}",
  "/api/v1/spaces/{spaceId}/tasks/{taskId}/complete",
  "/api/v1/spaces/{spaceId}/tasks/{taskId}/reopen",
  "/api/v1/families/{familyId}/tasks",
  "/api/v1/families/{familyId}/tasks/{taskId}",
  "/api/v1/families/{familyId}/tasks/{taskId}/complete",
  "/api/v1/families/{familyId}/tasks/{taskId}/reopen",
  "/api/v1/spaces/{spaceId}/day-records",
  "/api/v1/spaces/{spaceId}/day-records/{dayRecordId}",
  "/api/v1/spaces/{spaceId}/day-records/{dayRecordId}/archive",
  "/api/v1/spaces/{spaceId}/day-records/{dayRecordId}/restore",
  "/api/v1/spaces/{spaceId}/day-records/{dayRecordId}/occurrences",
  "/api/v1/families/{familyId}/day-records",
  "/api/v1/families/{familyId}/day-records/{dayRecordId}",
  "/api/v1/families/{familyId}/day-records/{dayRecordId}/archive",
  "/api/v1/families/{familyId}/day-records/{dayRecordId}/restore",
  "/api/v1/families/{familyId}/day-records/{dayRecordId}/occurrences",
  "/api/v1/spaces/{spaceId}/wishes",
  "/api/v1/spaces/{spaceId}/wishes/{wishId}",
  "/api/v1/spaces/{spaceId}/wishes/{wishId}/claim",
  "/api/v1/spaces/{spaceId}/wishes/{wishId}/unclaim",
  "/api/v1/spaces/{spaceId}/wishes/{wishId}/fulfill",
  "/api/v1/spaces/{spaceId}/wishes/{wishId}/reopen",
  "/api/v1/spaces/{spaceId}/wishes/{wishId}/archive",
  "/api/v1/spaces/{spaceId}/wishes/{wishId}/restore",
  "/api/v1/families/{familyId}/wishes",
  "/api/v1/families/{familyId}/wishes/{wishId}",
  "/api/v1/families/{familyId}/wishes/{wishId}/claim",
  "/api/v1/families/{familyId}/wishes/{wishId}/unclaim",
  "/api/v1/families/{familyId}/wishes/{wishId}/fulfill",
  "/api/v1/families/{familyId}/wishes/{wishId}/reopen",
  "/api/v1/families/{familyId}/wishes/{wishId}/archive",
  "/api/v1/families/{familyId}/wishes/{wishId}/restore",
  "/api/v1/spaces/{spaceId}/grants",
]) if (!document.paths?.[path]) throw new Error(`Core OpenAPI missing ${path}`);

const schemas = document.components?.schemas;
if (JSON.stringify(schemas?.SpaceRole?.enum) !== JSON.stringify(["owner", "admin", "editor", "viewer"])) throw new Error("Space roles drifted");
if (!schemas?.Space?.required?.includes("timezone") || !schemas?.Space?.required?.includes("version")) throw new Error("Space must expose timezone and version");
if (schemas?.UpdateSpaceRequest?.required?.[0] !== "version" || schemas?.UpdateSpaceRequest?.minProperties !== 2) throw new Error("Space updates must use optimistic concurrency");
if (schemas?.CreateInviteResponse?.properties?.data?.allOf?.[1]?.properties?.token?.writeOnly !== true) throw new Error("Invitation plaintext token must be one-time/write-only");
if (schemas?.Invite?.properties?.token) throw new Error("Stored/listed invites must not expose plaintext tokens");
if (schemas?.JoinInviteRequest?.additionalProperties !== false || !schemas?.JoinInviteRequest?.required?.includes("displayName")) throw new Error("Invitation join must create/reactivate a Space Person");
if (JSON.stringify(schemas?.LegacyFamilyRole?.enum) !== JSON.stringify(["admin", "member"])) throw new Error("HomeMew compatibility roles drifted");
if (schemas?.LegacyFamilyListItem?.properties?.avatarUrl?.type !== "null") throw new Error("Family avatar parity must stay unavailable before the R2 slice");
if (schemas?.LegacyCreateInviteResponse?.properties?.data?.properties?.code?.writeOnly !== true) throw new Error("HomeMew invitation code must be one-time/write-only");
if (document.paths?.["/api/v1/family-invites/{code}/join"]?.post?.responses?.["200"] === undefined) throw new Error("HomeMew invitation join must preserve the legacy 200 response");
if (!schemas?.EventCommon?.required?.includes("spaceId") || schemas?.EventCommon?.properties?.familyId) throw new Error("Native events must be Space-owned");
if (!schemas?.LegacyEventCommon?.required?.includes("familyId") || schemas?.LegacyEventCommon?.properties?.spaceId) throw new Error("HomeMew event responses must preserve familyId");
if (!schemas?.CreateEventCommon?.properties?.attendeePersonIds || schemas?.CreateEventCommon?.properties?.attendeeIds) throw new Error("Native attendees must reference Space People");
if (!schemas?.LegacyCreateEventCommon?.properties?.attendeeIds) throw new Error("HomeMew event attendee IDs must remain compatible");
if (schemas?.LegacyEventPersonRef?.properties?.avatarUrl?.type !== "null") throw new Error("Event attendee avatars must stay unavailable before the R2 slice");
if (JSON.stringify(schemas?.TaskStatus?.enum) !== JSON.stringify(["pending", "completed", "cancelled"])) throw new Error("Task statuses drifted");
if (!schemas?.Task?.required?.includes("spaceId") || schemas?.Task?.properties?.familyId) throw new Error("Native tasks must be Space-owned");
if (!schemas?.LegacyTask?.required?.includes("familyId") || schemas?.LegacyTask?.properties?.spaceId) throw new Error("HomeMew task responses must preserve familyId");
if (!schemas?.CreateTaskRequest?.properties?.assigneePersonIds || schemas?.CreateTaskRequest?.properties?.assigneeIds) throw new Error("Native task assignees must reference Space People");
if (!schemas?.LegacyCreateTaskRequest?.properties?.assigneeIds || schemas?.LegacyCreateTaskRequest?.properties?.assigneePersonIds) throw new Error("HomeMew task assignee IDs must remain compatible");
if (schemas?.LegacyTaskPersonRef?.properties?.avatarUrl?.type !== "null") throw new Error("Task assignee avatars must stay unavailable before the R2 slice");
if (schemas?.UpdateTaskRequest?.required?.[0] !== "version" || schemas?.UpdateTaskRequest?.minProperties !== 2) throw new Error("Native task updates must use optimistic concurrency");
if (schemas?.LegacyUpdateTaskRequest?.required?.[0] !== "version" || schemas?.LegacyUpdateTaskRequest?.minProperties !== 2) throw new Error("HomeMew task updates must preserve optimistic concurrency");
const legacyIncludeNoDue = document.paths?.["/api/v1/families/{familyId}/tasks"]?.get?.parameters?.find((parameter) => parameter?.name === "includeNoDue");
if (legacyIncludeNoDue?.schema?.default !== false) throw new Error("HomeMew task compatibility must document observed includeNoDue=false omission behavior");
if (JSON.stringify(schemas?.DayRecordKind?.enum) !== JSON.stringify(["elapsed", "countdown", "cycle"])) throw new Error("Day record kinds drifted");
if (JSON.stringify(schemas?.DayRecordStatus?.enum) !== JSON.stringify(["active", "archived"])) throw new Error("Day record statuses drifted");
if (!schemas?.DayRecordCommon?.required?.includes("spaceId") || schemas?.DayRecordCommon?.properties?.familyId) throw new Error("Native day records must be Space-owned");
if (!schemas?.LegacyDayRecordCommon?.required?.includes("familyId") || schemas?.LegacyDayRecordCommon?.properties?.spaceId) throw new Error("HomeMew day records must preserve familyId");
if (!schemas?.CreateDayRecordCommon?.properties?.subjectPersonId || schemas?.CreateDayRecordCommon?.properties?.subjectUserId) throw new Error("Native day-record subjects must reference Space People");
if (!schemas?.LegacyCreateDayRecordCommon?.properties?.subjectUserId || schemas?.LegacyCreateDayRecordCommon?.properties?.subjectPersonId) throw new Error("HomeMew day-record subjects must preserve user IDs");
if (schemas?.LegacyDayRecordPersonRef?.properties?.avatarUrl?.type !== "null") throw new Error("Day-record subject avatars must stay unavailable before the R2 slice");
if (schemas?.UpdateDayRecordRequest?.required?.[0] !== "version" || schemas?.UpdateDayRecordRequest?.minProperties !== 2) throw new Error("Native day-record updates must use optimistic concurrency");
if (schemas?.LegacyUpdateDayRecordRequest?.required?.[0] !== "version" || schemas?.LegacyUpdateDayRecordRequest?.minProperties !== 2) throw new Error("HomeMew day-record updates must preserve optimistic concurrency");
if (!schemas?.CreateDayRecordOccurrenceRequest?.required?.includes("occurredOn") || !schemas?.CreateDayRecordOccurrenceRequest?.required?.includes("version")) throw new Error("Day-record occurrences must advance by date under optimistic concurrency");
if (schemas?.DayRecordComputedBase?.additionalProperties === false) throw new Error("Day record computed base must allow allOf-derived computed fields");
for (const schemaName of [
  "CreateElapsedDayRecordRequest",
  "CreateCountdownDayRecordRequest",
  "CreateCycleDayRecordRequest",
  "LegacyCreateElapsedDayRecordRequest",
  "LegacyCreateCountdownDayRecordRequest",
  "LegacyCreateCycleDayRecordRequest",
]) {
  if (schemas?.[schemaName]?.allOf?.[1]?.additionalProperties === false) throw new Error(`${schemaName} must allow fields evaluated by its allOf common schema`);
}
if (document.paths?.["/api/v1/spaces/{spaceId}/day-records/{dayRecordId}/occurrences"]?.post?.responses?.["201"] === undefined) throw new Error("Native occurrence creation must preserve 201 semantics");
if (document.paths?.["/api/v1/families/{familyId}/day-records/{dayRecordId}/occurrences"]?.post?.responses?.["201"] === undefined) throw new Error("HomeMew occurrence creation must preserve 201 semantics");
if (JSON.stringify(schemas?.WishStatus?.enum) !== JSON.stringify(["open", "claimed", "fulfilled", "archived"])) throw new Error("Wish statuses drifted");
if (!schemas?.Wish?.required?.includes("spaceId") || schemas?.Wish?.properties?.familyId) throw new Error("Native wishes must be Space-owned");
if (!schemas?.LegacyWish?.required?.includes("familyId") || schemas?.LegacyWish?.properties?.spaceId) throw new Error("HomeMew wishes must preserve familyId");
if (!schemas?.Wish?.properties?.owner || !schemas?.Wish?.properties?.claimant || !schemas?.Wish?.properties?.fulfilledBy) throw new Error("Native wish lifecycle people are missing");
if (schemas?.WishPersonRef?.properties?.userId || !schemas?.WishPersonRef?.properties?.personId) throw new Error("Native wish people must use Space Person IDs");
if (!schemas?.LegacyWishPersonRef?.properties?.userId || schemas?.LegacyWishPersonRef?.properties?.personId) throw new Error("HomeMew wish people must preserve user IDs");
if (schemas?.LegacyWishPersonRef?.properties?.avatarUrl?.type !== "null") throw new Error("Wish person avatars must stay unavailable before the R2 slice");
if (schemas?.UpdateWishRequest?.required?.[0] !== "version" || schemas?.UpdateWishRequest?.minProperties !== 2) throw new Error("Native wish updates must use optimistic concurrency");
if (schemas?.LegacyUpdateWishRequest?.required?.[0] !== "version" || schemas?.LegacyUpdateWishRequest?.minProperties !== 2) throw new Error("HomeMew wish updates must preserve optimistic concurrency");
for (const action of ["claim", "unclaim", "fulfill", "reopen", "archive", "restore"]) {
  if (document.paths?.[`/api/v1/spaces/{spaceId}/wishes/{wishId}/${action}`]?.post?.responses?.["200"] === undefined) throw new Error(`Native wish ${action} must return 200`);
  if (document.paths?.[`/api/v1/families/{familyId}/wishes/{wishId}/${action}`]?.post?.responses?.["200"] === undefined) throw new Error(`HomeMew wish ${action} must preserve 200`);
}
if (schemas?.StatusResponse?.properties?.data?.properties?.contractVersion?.const !== "0.7.0") throw new Error("Core status contract version drifted");

console.log("Core OpenAPI contract sanity check passed");
