import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const workerUrl = new URL("../worker/configuration-center.ts", import.meta.url);
const agentEntrypointUrl = new URL("../worker/agent-governance.ts", import.meta.url);
const finalEntrypointUrl = new URL("../worker/external-configuration.ts", import.meta.url);
const wranglerUrl = new URL("../wrangler.jsonc", import.meta.url);
const workerPath = fileURLToPath(workerUrl);
const source = readFileSync(workerUrl, "utf8");
const agentEntrypoint = readFileSync(agentEntrypointUrl, "utf8");
const finalEntrypoint = readFileSync(finalEntrypointUrl, "utf8");
const wrangler = readFileSync(wranglerUrl, "utf8");

const required = [
  ["final Worker entrypoint", '"main": "worker/external-configuration.ts"', wrangler],
  ["Agent governance preserved behind External configuration", 'import agentGovernanceWorker from "./agent-governance"', finalEntrypoint],
  ["External configuration delegates unhandled routes", "agentGovernanceWorker.fetch(request, env)", finalEntrypoint],
  ["credential center preserved behind Agent governance", 'import configurationCenterWorker from "./configuration-center"', agentEntrypoint],
  ["Agent governance delegates unhandled routes", "configurationCenterWorker.fetch(request, env)", agentEntrypoint],
  ["AES-GCM sealed reveal", 'name: "AES-GCM"', source],
  ["short reveal lifetime", "REVEAL_TTL_MS = 60_000", source],
  ["environment-bound key derivation", "IDENTITY_APPLICATION_CREDENTIAL", source],
  ["opaque reveal ticket", "?ticket=", source],
  ["current admin re-verification", "requireIdentityAdminContext(request, env)", source],
  ["no-script reveal document", "script-src 'none'", source],
  ["no-store reveal document", "no-store, max-age=0", source],
  ["no-referrer reveal document", '"referrer-policy": "no-referrer"', source],
  ["same-origin resource policy", '"cross-origin-resource-policy": "same-origin"', source],
  ["application credential prefix validation", 'secret.startsWith("lsa_")', source],
  ["service token prefix validation", 'secret.startsWith("lsp_svc_")', source],
];

for (const [label, token, haystack] of required) {
  if (!haystack.includes(token)) throw new Error(`${workerPath} is missing ${label}: ${token}`);
}

const forbidden = [
  ["bootstrap authority", /LIFESPACE_STAGING_BOOTSTRAP_SECRET|x-bootstrap-secret/iu],
  ["local/session storage", /localStorage|sessionStorage/iu],
  ["client-side clipboard", /navigator\.clipboard|document\.execCommand/iu],
  ["plaintext secret query parameter", /[?&](?:secret|token|clientSecret)=/iu],
  ["credential handoff cookie", /Set-Cookie|set-cookie|HttpOnly|SameSite/iu],
  ["legacy credential reveal worker", /credential-reveal\.ts|credential-governance\.ts/iu],
];

for (const [label, pattern] of forbidden) {
  if (pattern.test(source) || pattern.test(agentEntrypoint) || pattern.test(finalEntrypoint)) throw new Error(`${workerPath} violates hardened reveal boundary: ${label}`);
}

console.log(JSON.stringify({
  ok: true,
  worker: "apps/console/worker/configuration-center.ts",
  finalEntrypoint: "apps/console/worker/external-configuration.ts",
  delegatedEntrypoints: ["apps/console/worker/agent-governance.ts", "apps/console/worker/configuration-center.ts"],
  finalEntrypointHardened: true,
  browserCookieSecretPlaintextAbsent: true,
  browserJavascriptPlaintextAbsent: true,
  sealedRevealTicket: true,
  currentAdminReverification: true,
  revealPageScriptDisabled: true,
  revealPageNoStore: true,
}));
