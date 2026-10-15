import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const workerUrl = new URL("../worker/configuration-center.ts", import.meta.url);
const agentEntrypointUrl = new URL("../worker/agent-governance.ts", import.meta.url);
const externalEntrypointUrl = new URL("../worker/external-connections.ts", import.meta.url);
const platformEntrypointUrl = new URL("../worker/platform-admin-entry.ts", import.meta.url);
const wranglerUrl = new URL("../wrangler.jsonc", import.meta.url);
const workerPath = fileURLToPath(workerUrl);
const source = readFileSync(workerUrl, "utf8");
const agentEntrypoint = readFileSync(agentEntrypointUrl, "utf8");
const externalEntrypoint = readFileSync(externalEntrypointUrl, "utf8");
const platformEntrypoint = readFileSync(platformEntrypointUrl, "utf8");
const wrangler = readFileSync(wranglerUrl, "utf8");

const required = [
  ["final Worker entrypoint", '"main": "worker/platform-admin-entry.ts"', wrangler],
  ["Platform Admin wrapper preserves External governance", 'import externalConnectionsWorker from "./external-connections"', platformEntrypoint],
  ["Platform Admin wrapper delegates non-overview routes", "externalConnectionsWorker.fetch(request, env)", platformEntrypoint],
  ["External Connection wrapper preserves Agent governance", 'import downstreamWorker from "./agent-governance"', externalEntrypoint],
  ["External Connection wrapper delegates unhandled routes", "downstreamWorker.fetch(request, env)", externalEntrypoint],
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
  if (
    pattern.test(source)
    || pattern.test(agentEntrypoint)
    || pattern.test(externalEntrypoint)
    || pattern.test(platformEntrypoint)
  ) throw new Error(`${workerPath} violates hardened reveal boundary: ${label}`);
}

console.log(JSON.stringify({
  ok: true,
  worker: "apps/console/worker/configuration-center.ts",
  finalEntrypoint: "apps/console/worker/platform-admin-entry.ts",
  finalEntrypointHardened: true,
  platformAdminWrapperPreserved: true,
  externalGovernancePreserved: true,
  agentGovernancePreserved: true,
  browserCookieSecretPlaintextAbsent: true,
  browserJavascriptPlaintextAbsent: true,
  sealedRevealTicket: true,
  currentAdminReverification: true,
  revealPageScriptDisabled: true,
  revealPageNoStore: true,
}));
