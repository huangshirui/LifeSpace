import fs from "node:fs";
const api = JSON.parse(fs.readFileSync(new URL("../openapi.json", import.meta.url), "utf8"));
const expect = ["/api/session", "/api/oauth/request", "/api/oauth/choices", "/api/oauth/confirm"];
if (api.openapi !== "3.1.0" || api.info.version !== "0.1.0") throw new Error("Account BFF contract mismatch");
for (const path of expect) if (!api.paths[path]) throw new Error("Missing Account route " + path);
const confirmation = api.paths["/api/oauth/confirm"].post;
const schema = confirmation?.requestBody?.content?.["application/json"]?.schema;
if (!schema || schema.additionalProperties !== false || schema.properties.intent.const !== "confirm-oauth-authorization"
    || !schema.required.includes("allowUserAuthorization") || !confirmation.responses?.["403"]) {
  throw new Error("Account Consent confirmation contract must require explicit intent, bounded shape and deny paths");
}
console.log("Account BFF OAuth Consent contract check passed");
