// Read-only Staging release gate. Passing means closed or exact-pinned
// public fetch; it is NOT proof of unrestricted DNS rebinding safety.
import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const WORKER = "lifespace-identity-staging";
const STRICT_PUBLIC_FLAG = "global_fetch_strictly_public";
// Independently pin the exact pilot set, not a wildcard or any URL from
// deployed environment settings. Production activation is not approved.
export const APPROVED_STAGING_CIMD_IDS = Object.freeze([
  "https://chatgpt.com/oauth/client.json",
  "https://cdn.jsdelivr.net/gh/huangshirui/LifeSpace@main/infra/cimd-network-probe/client.json",
]);

export function assessCimdStaging(settings = {}) {
  const bindings = Array.isArray(settings.bindings) ? settings.bindings : [];
  const compatibilityFlags = Array.isArray(settings.compatibility_flags) ? settings.compatibility_flags : [];
  const config = bindings.find(b => b.name === "OAUTH_CIMD_ENABLED");
  const pins = bindings.find(b => b.name === "OAUTH_CIMD_ALLOWED_CLIENT_IDS");
  const vpc = bindings.filter(b => b.type === "vpc_network" || b.name === "OAUTH_CIMD_EGRESS");
  const deploymentFlag = config?.type === "plain_text" ? config.text : "missing";
  const strictPublic = compatibilityFlags.includes(STRICT_PUBLIC_FLAG)
    && !compatibilityFlags.includes("global_fetch_private_origin");
  const boundary = strictPublic && vpc.length === 0;
  const allowedIds = pins?.type === "plain_text" && typeof pins.text === "string"
    ? pins.text.trim().split(/\s+/u).filter(Boolean) : [];
  const exactPins = allowedIds.length === APPROVED_STAGING_CIMD_IDS.length
    && new Set(allowedIds).size === allowedIds.length
    && APPROVED_STAGING_CIMD_IDS.every(id => allowedIds.includes(id));
  const rateLimits = ["OAUTH_DCR_RATE_LIMITER", "OAUTH_AUTHORIZE_RATE_LIMITER"]
    .every(name => bindings.some(b => b.name === name && b.type === "ratelimit"));
  const safeClosed = deploymentFlag === "0" && boundary;
  const safePinned = deploymentFlag === "1" && boundary && exactPins && rateLimits;
  return {
    safeClosed, safePinned, safe: safeClosed || safePinned,
    worker: WORKER, deploymentFlag, strictPublicFetch: strictPublic,
    exactPins, rateLimits, networkBindings: vpc.map(b => ({ name: b.name, type: b.type })),
    status: safeClosed ? "SAFE_CLOSED" : safePinned ? "SAFE_PINNED_PILOT" : "RELEASE_GATE_FAILED",
    note: "Bounded Staging only. Unrestricted CIMD and Production are not approved.",
  };
}

export async function auditCimdStaging({ accountId, token, getSettings } = {}) {
  assert.match(accountId || "", /^[a-f0-9]{32}$/u, "Cloudflare account ID required");
  assert.ok(typeof token === "string" && token.length > 5, "Cloudflare API token required");
  const fetchSettings = getSettings || (async () => {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${WORKER}/settings`,
      { headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15000), redirect: "error" },
    );
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.success !== true) {
      throw new Error(`Cloudflare Staging Worker read-only audit failed (HTTP ${response.status})`);
    }
    return data.result;
  });
  return assessCimdStaging(await fetchSettings());
}

async function main() {
  const result = await auditCimdStaging({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    token: process.env.CLOUDFLARE_API_TOKEN,
  });
  const config = JSON.parse(await readFile(new URL("../../apps/identity/wrangler.jsonc", import.meta.url), "utf8"));
  const expected = config.env.staging.vars.OAUTH_CIMD_ENABLED;
  console.log("Staging CIMD egress audit: " + JSON.stringify(result));
  assert.ok(result.safe && result.deploymentFlag === expected,
    "Staging CIMD settings must match the intended safe-closed or exact-pinned pilot; no VPC and strict public fetch");
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY,
      "\n## CIMD Staging Network Gate\n"
      + "- Staging release flag: `" + result.deploymentFlag + "`\n"
      + "- Strict-public fetch: `" + result.strictPublicFetch + "`\n"
      + "- Exact pilot pins: `" + result.exactPins + "`\n"
      + "- Required rate limit bindings: `" + result.rateLimits + "`\n"
      + "- Private network bindings: `" + result.networkBindings.length + "`\n"
      + "- Result: **" + result.status + "**\n"
      + "- Does not approve unrestricted CIMD, Production or human consent.\n");
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
