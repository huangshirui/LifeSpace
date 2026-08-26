import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const workerUrl = new URL("../worker/configuration-center.ts", import.meta.url);
const wranglerUrl = new URL("../wrangler.jsonc", import.meta.url);
const workerPath = fileURLToPath(workerUrl);
const source = readFileSync(workerUrl, "utf8");
const wrangler = readFileSync(wranglerUrl, "utf8");

const required = [
  ["final Worker entrypoint", '"main": "worker/configuration-center.ts"'],
  ["AES-GCM sealed reveal", 'name: "AES-GCM"'],
  ["short reveal lifetime", "REVEAL_TTL_MS = 60_000"],
  ["environment-bound key derivation", "IDENTITY_APPLICATION_CREDENTIAL"],
  ["opaque reveal ticket", "?ticket="],
  ["current admin re-verification", "requireIdentityAdminContext(request, env)"],
  ["no-script reveal document", "script-src 'none'"],
  ["no-store reveal document", "no-store, max-age=0"],
  ["no-referrer reveal document", '"referrer-policy": "no-referrer"'],
  ["same-origin resource policy", '"cross-origin-resource-policy": "same-origin"'],
  ["application credential prefix validation", 'secret.startsWith("lsa_")'],
  ["service token prefix validation", 'secret.startsWith("lsp_pat_")'],
];

for (const [label, token] of required) {
  const haystack = label === "final Worker entrypoint" ? wrangler : source;
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
  if (pattern.test(source)) throw new Error(`${workerPath} violates hardened reveal boundary: ${label}`);
}

console.log(JSON.stringify({
  ok: true,
  worker: "apps/console/worker/configuration-center.ts",
  finalEntrypointHardened: true,
  browserCookieSecretPlaintextAbsent: true,
  browserJavascriptPlaintextAbsent: true,
  sealedRevealTicket: true,
  currentAdminReverification: true,
  revealPageScriptDisabled: true,
  revealPageNoStore: true,
}));