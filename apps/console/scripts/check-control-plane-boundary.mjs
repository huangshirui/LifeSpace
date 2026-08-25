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
  ["bounded Model Access replacement", "/model-access"],
  ["whole-catalog target confirmation", "confirmApplicationId"],
  ["Model Definition validation", "/api/v1/model-admin/models/validate"],
  ["Model publication", "/api/v1/model-admin/models"],
  ["model publication target confirmation", "confirmModelKey"],
  ["breaking publication typed confirmation", "breakingConfirmation"],
  ["typed breaking sentinel", "BREAKING"],
  ["typed retirement confirmation", "Retirement requires confirmModelKey"],
];

for (const [label, token] of required) {
  if (!source.includes(token)) throw new Error(`${workerPath} is missing ${label}: ${token}`);
}

const forbidden = [
  ["bootstrap secret runtime authority", /LIFESPACE_STAGING_BOOTSTRAP_SECRET|x-bootstrap-secret/iu],
  ["browser-provided upstream Authorization", /request\.headers\.get\(["']authorization["']\)/iu],
  ["browser-provided target user authority", /actorUserId|targetUserId/iu],
  ["arbitrary reverse-proxy target", /upstreamUrl|targetUrl|proxyUrl/iu],
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
  publishConfirmationRequired: true,
  modelAccessReplacementConfirmationRequired: true,
}));
