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
if (document.openapi !== "3.1.0" || document.info?.version !== "0.2.0" || !path
  || !path.security?.some((entry) => entry.accountUserBearer)
  || !String(path.description ?? "").includes("manage")
  || path.requestBody?.content?.["application/json"]?.schema?.additionalProperties !== false
  || !path.responses?.["200"] || !path.responses?.["403"]) {
  throw new Error("Core OAuth Consent contract must preserve Account-only, current Space management approval semantics");
}
const lifetimeApproval = document.paths?.["/api/v1/me/oauth/delegation-requests/{requestId}/{decision}"]?.post;
const lifetimeShape = lifetimeApproval?.requestBody?.content?.["application/json"]?.schema;
if (!lifetimeApproval?.security?.some((entry) => entry.accountUserBearer)
  || lifetimeShape?.additionalProperties !== false
  || JSON.stringify(lifetimeShape?.properties?.mode?.enum) !== JSON.stringify(["once", "timed", "until_revoked"])
  || JSON.stringify(lifetimeShape?.properties?.durationMinutes?.enum) !== JSON.stringify([60, 1440, 10080])
  || !document.paths?.["/api/v1/me/oauth/delegations"]?.get
  || !document.paths?.["/api/v1/me/oauth/delegations/{delegationId}/revoke"]?.post) {
  throw new Error("Core Account-selected lifetime and User-owned revoke contracts are incomplete");
}
console.log("Core OAuth Consent and Account-selected Delegation lifetime companion contract checks passed");
