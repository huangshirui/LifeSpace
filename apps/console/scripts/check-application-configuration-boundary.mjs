import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const workerUrl = new URL("../worker/application-configuration.ts", import.meta.url);
const workerPath = fileURLToPath(workerUrl);
const source = readFileSync(workerUrl, "utf8");

const required = [
  ["delegation to established control plane", "./control-plane"],
  ["raw Cloudflare Access assertion", "cf-access-jwt-assertion"],
  ["operation-specific browser intent", "x-lifespace-console-intent"],
  ["exact Origin comparison", "origin !== url.origin"],
  ["Fetch Metadata same-origin check", "fetchSite !== \"same-origin\""],
  ["JSON content-type requirement", "contentType.startsWith(\"application/json\")"],
  ["Identity Access exchange", "/internal/v1/access/tokens"],
  ["short-lived platform-admin actor proof", "/api/v1/me/platform-admin-actor-token"],
  ["actor proof forwarding", "x-lifespace-actor-token"],
  ["server-only Identity executor", "IDENTITY_APPLICATION_CREDENTIAL"],
  ["platform Application admin route", "/internal/v1/platform-admin/applications"],
  ["Application creation confirmation", "confirmName"],
  ["Application update confirmation", "confirmApplicationId"],
  ["Access audience registration", "/access-audiences"],
  ["Access audience revocation confirmation", "confirmAudienceId"],
  ["trusted-backend bootstrap credential cleanup", "INITIAL_CREDENTIAL_REVOKE_FAILED"],
  ["browser response Application allowlist", "sanitizeApplication"],
  ["browser response audience allowlist", "sanitizeAudience"],
];

for (const [label, token] of required) {
  if (!source.includes(token)) throw new Error(`${workerPath} is missing ${label}: ${token}`);
}

const forbidden = [
  ["bootstrap secret runtime authority", /LIFESPACE_STAGING_BOOTSTRAP_SECRET|x-bootstrap-secret/iu],
  ["browser-provided upstream Authorization", /request\.headers\.get\(["']authorization["']\)/iu],
  ["browser-provided target user authority", /actorUserId|targetUserId/iu],
  ["arbitrary reverse-proxy target", /upstreamUrl|targetUrl|proxyUrl/iu],
  ["one-time lsa plaintext browser handling", /clientSecret|lsa_/iu],
  ["Core executor use in Application configuration", /coreExecutor\s*=|authorization:\s*`Bearer \$\{context\.core/iu],
];

for (const [label, pattern] of forbidden) {
  if (pattern.test(source)) throw new Error(`${workerPath} violates Application configuration boundary: ${label}`);
}

console.log(JSON.stringify({
  ok: true,
  worker: "apps/console/worker/application-configuration.ts",
  identityOnlyAuthority: true,
  browserMutationGuardPresent: true,
  applicationTargetConfirmationRequired: true,
  audienceTargetConfirmationRequired: true,
  managedSecretPlaintextExcluded: true,
  trustedBackendBootstrapCredentialRevokedServerSide: true,
}));
