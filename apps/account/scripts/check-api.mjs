import fs from "node:fs";
const api = JSON.parse(fs.readFileSync(new URL("../openapi.json", import.meta.url), "utf8"));
const expect = ["/api/account/authorizations",
  "/api/account/authorizations/{authorizationId}",
  "/api/account/authorizations/{authorizationId}/revoke", "/api/account/login-email", "/api/account/login-email/change",
  "/api/account/profile", "/api/account/profile/avatar", "/api/account/spaces",
  "/api/account/spaces/create", "/api/account/spaces/invite-preview", "/api/account/spaces/join",
  "/api/account/spaces/{spaceId}", "/api/account/spaces/{spaceId}/members", "/api/account/spaces/{spaceId}/external-connections", "/api/session", "/api/oauth/request", "/api/oauth/choices", "/api/oauth/capabilities", "/api/oauth/confirm"];
if (api.openapi !== "3.1.0" || api.info.version !== "0.7.0") throw new Error("Account BFF contract mismatch");
for (const path of expect) if (!api.paths[path]) throw new Error("Missing Account route " + path);
const ceilingPath="/api/account/spaces/{spaceId}/members/{userId}/model-access";
const ceiling=api.paths[ceilingPath+"/{modelKey}"]?.post;
if(!api.paths[ceilingPath]?.get||!ceiling?.responses?.["403"]
  ||ceiling.requestBody?.content?.["application/json"]?.schema?.properties?.intent?.const!=="change-member-model-access")
  throw new Error("Missing bounded Account member ceiling contract");
const session = api.paths["/api/session"].get;
if (!session.parameters?.some(p=>p.name==="include"&&p.schema?.enum?.join(",")==="login-email")
  || !session.responses?.["400"] || !session.responses?.["403"])
  throw new Error("Account session optional mailbox contract invalid");
const confirmation = api.paths["/api/oauth/confirm"].post;
const schema = confirmation?.requestBody?.content?.["application/json"]?.schema;
if (!schema || schema.additionalProperties !== false || schema.properties.intent.const !== "confirm-oauth-authorization"
    || !schema.required.includes("allowUserAuthorization") || !confirmation.responses?.["403"]) {
  throw new Error("Account Consent confirmation contract must require explicit intent, bounded shape and deny paths");
}
const projection = api.paths["/api/oauth/capabilities"]?.get;
if (!projection?.parameters?.some((entry) => entry.name === "request_id")
  || !String(projection?.summary).includes("pre-policy")) {
  throw new Error("Consent capability projection must be bound to pending OAuth scope and marked as a preview");
}
const approval = api.paths["/api/delegation/approve"]?.post;
const approvalSchema = approval?.requestBody?.content?.["application/json"]?.schema;
const mode = approvalSchema?.properties?.mode;
const duration = approvalSchema?.properties?.durationMinutes;
if (approvalSchema?.additionalProperties !== false
    || JSON.stringify(mode?.enum) !== JSON.stringify(["once", "timed", "until_revoked"])
    || JSON.stringify(duration?.enum) !== JSON.stringify([60, 1440, 10080])
    || !api.paths["/api/delegations"]?.get
    || !api.paths["/api/delegations/revoke"]?.post) {
  throw new Error("Account lifetime/owner-revocation contract is missing or unbounded");
}
const revoke=api.paths["/api/account/authorizations/{authorizationId}/revoke"]?.post;
const revokeSchema=revoke?.requestBody?.content?.["application/json"]?.schema;
if(!revoke?.responses?.["403"] || revokeSchema?.additionalProperties!==false
  || revokeSchema?.properties?.intent?.const!=="revoke-oauth-authorization")
  throw new Error("Account-owned OAuth revoke must be explicit and CSRF protected");
for(const path of ["/api/account/profile","/api/account/login-email/change",
  "/api/account/spaces/create","/api/account/spaces/invite-preview","/api/account/spaces/join"]){
  const post=api.paths[path]?.post;
  const schema=post?.requestBody?.content?.["application/json"]?.schema;
  if(!schema || schema.additionalProperties!==false || !schema.required?.includes("intent")
    || !post.responses?.["403"])throw new Error("Account self-service contract must be bounded and CSRF-protected: "+path);
}
const avatar=api.paths["/api/account/profile/avatar"]?.post;
if(!avatar?.requestBody?.content?.["multipart/form-data"] || !avatar.responses?.["403"])
  throw new Error("Avatar upload contract is missing its validation/CSRF boundary");
for(const action of ["update","close","leave"]){
  const post=api.paths["/api/account/spaces/{spaceId}/"+action]?.post;
  const schema=post?.requestBody?.content?.["application/json"]?.schema;
  if(schema?.additionalProperties!==false||schema.properties?.intent?.const!==action+"-space"
    ||!schema.required?.includes("confirmSpaceId")||!post.responses?.["403"]
    ||(action!=="leave"&&!schema.required?.includes("version")))
    throw new Error("Missing bounded Space settings contract: "+action);
}
console.log("Account Center, OAuth Consent and User Delegation contracts passed");
