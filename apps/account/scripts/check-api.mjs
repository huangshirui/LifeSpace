import fs from "node:fs";
const api = JSON.parse(fs.readFileSync(new URL("../openapi.json", import.meta.url), "utf8"));
const expect = ["/api/session", "/api/oauth/request", "/api/oauth/choices", "/api/oauth/capabilities", "/api/oauth/confirm", "/api/account/spaces"];
if (api.openapi !== "3.1.0" || api.info.version !== "0.2.0") throw new Error("Account BFF contract mismatch");
for (const path of expect) if (!api.paths[path]) throw new Error("Missing Account route " + path);
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
const spaces = api.paths["/api/account/spaces"];
if (!spaces?.get?.responses?.["200"] || !spaces?.get?.responses?.["403"]
  || spaces.post || spaces.patch || spaces.delete) {
  throw new Error("Account Spaces must be read-only and deny unauthorized callers");
}
console.log("Account Center + OAuth Consent BFF contract check passed");
