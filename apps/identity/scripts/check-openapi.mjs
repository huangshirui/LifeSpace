import fs from "node:fs";
import YAML from "yaml";

const doc = YAML.parse(fs.readFileSync(new URL("../openapi.yaml",import.meta.url),"utf8"));
if (doc.openapi !== "3.1.0" || doc.info?.version !== "0.2.0") {
  throw new Error("Identity OpenAPI version metadata is invalid");
}

for (const path of [
  "/health",
  "/api/v1/status",
  "/assets/users/{userId}/avatar",
  "/api/v1/me",
  "/api/v1/me/avatar",
  "/bootstrap/v1/applications",
  "/internal/v1/users",
  "/internal/v1/tokens",
]) {
  if (!doc.paths?.[path]) throw new Error(`Identity OpenAPI missing ${path}`);
}

if (doc.paths?.["/internal/v1/external-identities"]) {
  throw new Error("Application-owned external identity mappings must not be exposed by LifeSpace Identity");
}

const bootstrapDescription = doc.paths?.["/bootstrap/v1/applications"]?.post?.description ?? "";
if (!bootstrapDescription.includes("300-3600")) {
  throw new Error("Identity contract must document the application access-token TTL range");
}

const tokenDescription = doc.paths?.["/internal/v1/tokens"]?.post?.description ?? "";
if (!tokenDescription.includes("Core and Identity")) {
  throw new Error("Identity contract must document the multi-resource user-token audience");
}

const profile = doc.components?.schemas?.UserProfile;
if (!profile?.properties?.avatarUrl || !doc.paths?.["/api/v1/me/avatar"]?.put) {
  throw new Error("Identity contract must expose native user profile/avatar behavior");
}

console.log("Identity OpenAPI contract sanity check passed");
