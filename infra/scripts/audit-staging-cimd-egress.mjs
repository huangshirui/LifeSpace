// Read-only check of the deployed LifeSpace Staging CIMD network boundary.
// The Cloudflare runtime's global_fetch_strictly_public flag forces public
// Internet routing even for same-zone URLs. No VPC Network egress is allowed.
// Checks deployed configuration only. Actual relay and CIMD admission are
// independently verified by the owner-gated canonical staging workflow.
//
// This audit never modifies Cloudflare configuration or Production.
import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const WORKER = "lifespace-identity-staging";
const STRICT_PUBLIC_FLAG = "global_fetch_strictly_public";

export function assessCimdStaging(settings = {}, expected = {}) {
  const bindings = Array.isArray(settings.bindings) ? settings.bindings : [];
  const compatibilityFlags = Array.isArray(settings.compatibility_flags) ? settings.compatibility_flags : [];
  const config = bindings.find(binding => binding.name === "OAUTH_CIMD_ENABLED");
  const vpc = bindings.filter(binding => binding.type === "vpc_network" || binding.name === "OAUTH_CIMD_EGRESS");
  const explicitOff = config?.type === "plain_text" && config.text === "0";
  const strictPublic = compatibilityFlags.includes(STRICT_PUBLIC_FLAG) && !compatibilityFlags.includes("global_fetch_private_origin");
  const noPrivateEgress = vpc.length === 0;
  const safeClosed = explicitOff && strictPublic && noPrivateEgress;
  const endpoint = bindings.find(b => b.name === "OAUTH_CIMD_EGRESS_URL");
  const secret = bindings.find(b => b.name === "OAUTH_CIMD_EGRESS_SECRET");
  const limits = ["OAUTH_DCR_RATE_LIMITER", "OAUTH_AUTHORIZE_RATE_LIMITER"]
    .every(name => bindings.some(b => b.name === name && b.type === "ratelimit"));
  const explicitOn = config?.type === "plain_text" && config.text === "1";
  const configuredRelay = typeof expected.endpoint === "string" && expected.endpoint.length > 0
    && endpoint?.type === "plain_text" && endpoint.text === expected.endpoint
    && secret?.type === "secret_text";
  const relayConfigured = explicitOn && strictPublic && noPrivateEgress && configuredRelay && limits;
  const expectedEnabled = expected.enabled === true;
  const safe = expectedEnabled ? relayConfigured : safeClosed;
  return {
    safeClosed, relayConfigured, safe,
    worker: WORKER,
    deploymentFlag: config?.type === "plain_text" ? config.text : "missing",
    strictPublicFetch: strictPublic,
    networkBindings: vpc.map(b => ({ name: b.name, type: b.type })),
    status: safe ? (expectedEnabled ? "RELAY_CONFIGURED" : "SAFE_CLOSED") : "RELEASE_GATE_FAILED",
    note: "Configuration gate only; independent relay preflight and live protocol tests are required when enabled.",
  };
}

export async function auditCimdStaging({ accountId, token, getSettings, expected = {} } = {}) {
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
  return assessCimdStaging(await fetchSettings(), expected);
}

async function main() {
  const result = await auditCimdStaging({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    token: process.env.CLOUDFLARE_API_TOKEN,
    expected: { enabled: process.env.LIFESPACE_CIMD_ENABLED === "1", endpoint: process.env.OAUTH_CIMD_EGRESS_URL },
  });
  console.log("Staging CIMD egress audit: " + JSON.stringify(result));
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY,
      "\n## CIMD Public-Only Network Gate\n"
      + "- Staging release flag: `" + result.deploymentFlag + "`\n"
      + "- Cloudflare global fetch strictly public: `" + result.strictPublicFetch + "`\n"
      + "- VPC/private egress bindings: `" + result.networkBindings.length + "`\n"
      + "- Result: **" + result.status + "**\n"
      + "- Relay configured: `" + result.relayConfigured + "`\n"
      + "- Configuration gate only; live relay and admission evidence is separate.\n");
  }
  if (!result.safe) {
    throw new Error(
      "Staging CIMD requires the expected release state, strict-public fetch, no VPC, and the verified relay configuration when enabled",
    );
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
