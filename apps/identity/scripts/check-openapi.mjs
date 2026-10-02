import fs from "node:fs";
import YAML from "yaml";

const doc = YAML.parse(fs.readFileSync(new URL("../openapi.yaml",import.meta.url),"utf8"));
if (doc.openapi !== "3.1.0" || doc.info?.version !== "0.7.0") {
  throw new Error("Identity OpenAPI version metadata is invalid");
}

for (const path of [
  "/health",
  "/api/v1/status",
  "/assets/users/{userId}/avatar",
  "/api/v1/me",
  "/api/v1/me/avatar",
  "/api/v1/me/access-link-challenges/{challengeId}/confirm",
  "/bootstrap/v1/applications",
  "/bootstrap/v1/applications/{applicationId}",
  "/bootstrap/v1/applications/{applicationId}/credentials",
  "/bootstrap/v1/applications/{applicationId}/credentials/{credentialId}",
  "/bootstrap/v1/applications/{applicationId}/access-audiences",
  "/bootstrap/v1/applications/{applicationId}/access-audiences/{audienceId}",
  "/internal/v1/users",
  "/internal/v1/tokens",
  "/internal/v1/access/tokens",
  "/internal/v1/access/registrations",
  "/internal/v1/access/link-challenges",
  "/internal/v1/agents",
  "/internal/v1/agent-tokens",
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

const applicationCredential = doc.components?.schemas?.ApplicationCredential;
if (!applicationCredential || applicationCredential.properties?.clientSecret || applicationCredential.properties?.secretHash) {
  throw new Error("Listed application credential metadata must never expose plaintext or hashes");
}
const createdApplicationSecret = doc.components?.schemas?.CreateApplicationCredentialResponse?.properties?.data?.allOf?.[1]?.properties?.clientSecret;
if (createdApplicationSecret?.writeOnly !== true || !String(createdApplicationSecret?.pattern ?? "").includes("lsa_")) {
  throw new Error("New lsa_ application credential plaintext must be one-time/write-only");
}
const applicationPatch = doc.paths?.["/bootstrap/v1/applications/{applicationId}"]?.patch;
if (!applicationPatch || doc.components?.schemas?.UpdateApplicationRequest?.properties?.trustedBackend || doc.components?.schemas?.UpdateApplicationRequest?.properties?.clientType) {
  throw new Error("Application admin must expose bounded mutable policy without changing trust/client classification");
}

const accessAudience = doc.components?.schemas?.AccessAudience;
if (!accessAudience?.properties?.issuer || !accessAudience?.properties?.audience || accessAudience?.properties?.subject || accessAudience?.properties?.userId) {
  throw new Error("Access audience registration must bind issuer/audience to an application without becoming a user identity mapping");
}
const accessExchange = doc.components?.schemas?.AccessTokenExchangeRequest;
const accessRegistration = doc.components?.schemas?.AccessRegistrationRequest;
const accessChallenge = doc.components?.schemas?.AccessLinkChallengeRequest;
for (const [name, schema] of [["exchange", accessExchange], ["registration", accessRegistration], ["link challenge", accessChallenge]]) {
  if (!schema?.properties?.accessAssertion || schema.properties.accessAssertion.writeOnly !== true) {
    throw new Error(`Access ${name} must accept a write-only verifiable Access assertion`);
  }
  if (schema.properties?.userId || schema.properties?.subject || schema.properties?.email) {
    throw new Error(`Access ${name} must not trust client-supplied userId, subject or email identity fields`);
  }
}
if (!String(doc.paths?.["/internal/v1/access/tokens"]?.post?.description ?? "").includes("(iss, sub)")) {
  throw new Error("Access exchange contract must define (iss, sub) as the platform principal key");
}
if (!String(doc.paths?.["/internal/v1/access/registrations"]?.post?.description ?? "").includes("atomic")) {
  throw new Error("Access new-user registration must document atomic user + principal creation");
}
const confirmSecurity = doc.paths?.["/api/v1/me/access-link-challenges/{challengeId}/confirm"]?.post?.security ?? [];
if (!confirmSecurity.some((entry) => entry?.userBearer)) {
  throw new Error("Access link confirmation must derive proof of control from a LifeSpace user bearer token");
}

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

const agentTokenPost = doc.paths?.["/internal/v1/agent-tokens"]?.post;
if (!String(agentTokenPost?.description ?? "").includes("Core-only") || !String(agentTokenPost?.description ?? "").includes("Delegation")) {
  throw new Error("Agent token contract must remain Core-only and delegate current authority to Core");
}
if (doc.components?.schemas?.Agent?.properties?.id?.pattern !== "^agt_" || doc.components?.schemas?.AgentTokenResponse?.properties?.data?.properties?.actor?.properties?.type?.const !== "agent") {
  throw new Error("Identity Agent contract must expose stable agt_* identity and actor semantics");
}
