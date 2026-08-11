import fs from "node:fs";
import YAML from "yaml";

const doc = YAML.parse(fs.readFileSync(new URL("../openapi.yaml",import.meta.url),"utf8"));
if (doc.openapi !== "3.1.0" || doc.info?.version !== "0.3.0") {
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
  "/api/v1/service-principals",
  "/api/v1/service-principals/{principalId}",
  "/api/v1/service-principals/{principalId}/tokens",
  "/api/v1/service-principals/{principalId}/tokens/{tokenId}",
  "/api/v1/service-principals/{principalId}/oauth-credentials",
  "/api/v1/service-principals/{principalId}/oauth-credentials/{credentialId}",
  "/oauth/token",
  "/introspection/v1/service-tokens",
]) {
  if (!doc.paths?.[path]) throw new Error(`Identity OpenAPI missing ${path}`);
}

if (doc.paths?.["/internal/v1/external-identities"]) {
  throw new Error("Application-owned external identity mappings must not be exposed by LifeSpace Identity");
}

const bootstrapDescription = doc.paths?.["/bootstrap/v1/applications"]?.post?.description ?? "";
if (!bootstrapDescription.includes("300-3600")) throw new Error("Identity contract must document the application access-token TTL range");

const tokenDescription = doc.paths?.["/internal/v1/tokens"]?.post?.description ?? "";
if (!tokenDescription.includes("Core and Identity")) throw new Error("Identity contract must document the multi-resource user-token audience");

const profile = doc.components?.schemas?.UserProfile;
if (!profile?.properties?.avatarUrl || !doc.paths?.["/api/v1/me/avatar"]?.put) throw new Error("Identity contract must expose native user profile/avatar behavior");

const serviceToken = doc.components?.schemas?.ServiceToken;
if (!serviceToken || serviceToken.properties?.token || serviceToken.properties?.tokenHash || serviceToken.properties?.secretHash) {
  throw new Error("Listed Service API Token metadata must never expose plaintext or hashes");
}
const createdToken = doc.components?.schemas?.CreateServiceTokenResponse?.properties?.data?.allOf?.[1]?.properties?.token;
if (createdToken?.writeOnly !== true || !String(createdToken?.pattern ?? "").includes("lsp_pat_")) {
  throw new Error("New lsp_pat plaintext must be one-time/write-only");
}
const oauthSecret = doc.components?.schemas?.CreateOAuthCredentialResponse?.properties?.data?.allOf?.[1]?.properties?.clientSecret;
if (oauthSecret?.writeOnly !== true || !String(oauthSecret?.pattern ?? "").includes("lsp_client_")) {
  throw new Error("OAuth client secret must be one-time/write-only");
}
if (doc.paths?.["/oauth/token"]?.post?.security?.length !== 0) throw new Error("OAuth token endpoint must use OAuth client authentication, not a platform bearer requirement");
const introspectionSecurity = doc.paths?.["/introspection/v1/service-tokens"]?.post?.security ?? [];
if (!introspectionSecurity.some((entry) => entry?.internalServiceSecret && entry?.serviceToken)) {
  throw new Error("Opaque token introspection must require both internal Core authentication and the presented service token");
}
if (doc.components?.securitySchemes?.serviceToken?.bearerFormat !== "lsp_pat_ opaque token") throw new Error("Identity contract must distinguish opaque Service API Tokens from JWTs");

console.log("Identity OpenAPI contract sanity check passed");
