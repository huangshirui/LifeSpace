import fs from "node:fs";
import YAML from "yaml";

const document = YAML.parse(fs.readFileSync(new URL("../oauth-consent.openapi.yaml", import.meta.url), "utf8"));
const choices = document.paths?.["/api/v1/me/oauth/choices"]?.get;
const options = document.paths?.["/api/v1/me/oauth/spaces/{spaceId}/options"]?.get;
const preview = document.paths?.["/api/v1/me/oauth/capabilities"]?.get;
if (!preview?.security?.some((entry) => entry.accountUserBearer)
  || !String(preview.description).includes("upper-bound")) {
  throw new Error("Account capability preview must be explicitly authenticated and non-authoritative");
}
if (!choices?.security?.some((entry) => entry.accountUserBearer)
  || !options?.security?.some((entry) => entry.accountUserBearer)) {
  throw new Error("OAuth choices must require verified Account User");
}
const path = document.paths?.["/api/v1/me/oauth/requests/{requestId}/confirm"]?.post;
if (document.openapi !== "3.1.0" || document.info?.version !== "0.1.0" || !path
  || !path.security?.some((entry) => entry.accountUserBearer)
  || !String(path.description ?? "").includes("manage")
  || path.requestBody?.content?.["application/json"]?.schema?.additionalProperties !== false
  || !path.responses?.["200"] || !path.responses?.["403"]) {
  throw new Error("Core OAuth Consent contract must preserve Account-only, current Space management approval semantics");
}
console.log("Core OAuth Consent companion contract check passed");
