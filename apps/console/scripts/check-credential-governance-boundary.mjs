import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const workerUrl = new URL("../worker/configuration-center.ts", import.meta.url);
const workerPath = fileURLToPath(workerUrl);
const source = readFileSync(workerUrl, "utf8");

const required = [
  ["delegation to Application configuration", "./application-configuration"],
  ["raw Cloudflare Access assertion", "cf-access-jwt-assertion"],
  ["operation-specific browser intent", "x-lifespace-console-intent"],
  ["exact Origin comparison", "origin !== url.origin"],
  ["Fetch Metadata same-origin check", "fetchSite !== \"same-origin\""],
  ["Identity Access exchange", "/internal/v1/access/tokens"],
  ["platform-admin actor proof", "/api/v1/me/platform-admin-actor-token"],
  ["Identity executor", "IDENTITY_APPLICATION_CREDENTIAL"],
  ["application credential route", "/credentials"],
  ["service principal route", "/service-principals"],
  ["Service API Token route", "/tokens"],
  ["credential target confirmation", "confirmCredentialId"],
  ["principal target confirmation", "confirmPrincipalId"],
  ["token target confirmation", "confirmTokenId"],
  ["credential response allowlist", "sanitizeCredential"],
  ["principal response allowlist", "sanitizePrincipal"],
  ["token response allowlist", "sanitizeToken"],
  ["one-time application secret validation", "secret.startsWith(\"lsa_\")"],
  ["one-time token validation", "secret.startsWith(\"lsp_pat_\")"],
  ["sealed reveal locator", "revealPath: path"],
];

for (const [label, token] of required) {
  if (!source.includes(token)) throw new Error(`${workerPath} is missing ${label}: ${token}`);
}

const forbidden = [
  ["bootstrap runtime authority", /LIFESPACE_STAGING_BOOTSTRAP_SECRET|x-bootstrap-secret/iu],
  ["browser-provided upstream Authorization", /request\.headers\.get\(["']authorization["']\)/iu],
  ["browser-provided actor identity", /actorUserId|targetUserId/iu],
  ["arbitrary reverse proxy", /upstreamUrl|targetUrl|proxyUrl/iu],
  ["Core executor use", /CORE_EXECUTOR_BEARER\?\.trim|authorization:\s*`Bearer \$\{[^}]*core/iu],
  ["secret in local/session storage", /localStorage|sessionStorage/iu],
  ["client-side clipboard script", /navigator\.clipboard|document\.execCommand/iu],
  ["browser cookie credential handoff", /Set-Cookie|set-cookie|HttpOnly|SameSite/iu],
];

for (const [label, pattern] of forbidden) {
  if (pattern.test(source)) throw new Error(`${workerPath} violates credential governance boundary: ${label}`);
}

const jsonSecretLeakPatterns = [
  /json\([^\n]*clientSecret/iu,
  /json\([^\n]*secret\s*[,}]/iu,
  /json\([^\n]*token:\s*secret/iu,
];
for (const pattern of jsonSecretLeakPatterns) {
  if (pattern.test(source)) throw new Error(`${workerPath} appears to return one-time credential plaintext through JSON`);
}

console.log(JSON.stringify({
  ok: true,
  worker: "apps/console/worker/configuration-center.ts",
  identityOnlyAuthority: true,
  browserJavascriptSecretPlaintextAbsent: true,
  browserCookieSecretPlaintextAbsent: true,
  sealedRevealHandoffPresent: true,
  credentialPrincipalTokenConfirmationsPresent: true,
}));