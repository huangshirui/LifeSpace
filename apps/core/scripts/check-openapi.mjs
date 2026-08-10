import fs from "node:fs";
import YAML from "yaml";

const document = YAML.parse(fs.readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8"));
if (document.openapi !== "3.1.0" || document.info?.version !== "0.3.0") throw new Error("Core OpenAPI version metadata is invalid");

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

console.log("Core OpenAPI contract sanity check passed");
