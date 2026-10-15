import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const workerUrl = new URL("../worker/control-plane.ts", import.meta.url);
const workerPath = fileURLToPath(workerUrl);
const source = readFileSync(workerUrl, "utf8");

const required = [
  ["raw Cloudflare Access assertion", "cf-access-jwt-assertion"],
  ["operation-specific browser intent", "x-lifespace-console-intent"],
  ["exact Origin comparison", "origin !== url.origin"],
  ["Fetch Metadata same-origin check", "fetchSite !== \"same-origin\""],
  ["JSON content-type requirement", "contentType.startsWith(\"application/json\")"],
  ["Identity Access exchange", "/internal/v1/access/tokens"],
  ["short-lived platform-admin actor proof", "/api/v1/me/platform-admin-actor-token"],
  ["actor proof forwarding", "x-lifespace-actor-token"],
  ["server-only Identity executor", "IDENTITY_APPLICATION_CREDENTIAL"],
  ["server-only Core executor", "CORE_EXECUTOR_BEARER"],
  ["bounded Model Access replacement", "/platform-admin/applications/"],
  ["whole-catalog target confirmation", "confirmApplicationId"],
  ["Platform Admin model list", "/api/v1/platform-admin/models"],
  ["Platform Admin Model Definition validation", "/api/v1/platform-admin/models/validate"],
  ["model publication target confirmation", "confirmModelKey"],
  ["breaking publication typed confirmation", "breakingConfirmation"],
  ["typed breaking sentinel", "BREAKING"],
  ["typed retirement confirmation", "Retirement requires confirmModelKey"],
  ["Platform Admin Data Grant collection", "/platform-admin/spaces/"],
  ["grant creation target confirmation", "confirmSpaceId"],
  ["grant mutation target confirmation", "confirmGrantId"],
  ["grant create intent", "create-space-data-grant"],
  ["grant update intent", "update-space-data-grant"],
  ["grant revoke intent", "revoke-space-data-grant"],
];

for (const [label, token] of required) {
  if (!source.includes(token)) throw new Error(`${workerPath} is missing ${label}: ${token}`);
}

const forbidden = [
  ["bootstrap secret runtime authority", /LIFESPACE_STAGING_BOOTSTRAP_SECRET|x-bootstrap-secret/iu],
  ["browser-provided upstream Authorization", /request\.headers\.get\(["']authorization["']\)/iu],
  ["browser-provided target user authority", /actorUserId|targetUserId/iu],
  ["arbitrary reverse-proxy target", /upstreamUrl|targetUrl|proxyUrl/iu],
  ["Console use of service-automation Model Admin namespace", /\/api\/v1\/model-admin\//u],
];

for (const [label, pattern] of forbidden) {
  if (pattern.test(source)) throw new Error(`${workerPath} violates Console control-plane boundary: ${label}`);
}

console.log(JSON.stringify({
  ok: true,
  worker: "apps/console/worker/control-plane.ts",
  accessAssertionServerOnly: true,
  actorProofRequired: true,
  executorsServerOnly: true,
  bootstrapAuthorityAbsent: true,
  browserMutationGuardPresent: true,
  modelGovernanceUsesPlatformAdminNamespace: true,
  publishConfirmationRequired: true,
  modelAccessReplacementConfirmationRequired: true,
  dataGrantTargetConfirmationRequired: true,
}));
