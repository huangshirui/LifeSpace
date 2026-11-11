// Read-only check of the deployed LifeSpace Staging CIMD network boundary.
// The Cloudflare runtime's global_fetch_strictly_public flag forces public
// Internet routing even for same-zone URLs. No VPC Network egress is allowed.
// Passing means SAFE CLOSED, not "DNS rebinding E2E verified" or CIMD enabled.
//
// This audit never modifies Cloudflare configuration or Production.
import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const WORKER = "lifespace-identity-staging";
const STRICT_PUBLIC_FLAG = "global_fetch_strictly_public";

export function assessCimdStaging(settings = {}) {
  const bindings = Array.isArray(settings.bindings) ? settings.bindings : [];
  const compatibilityFlags = Array.isArray(settings.compatibility_flags) ? settings.compatibility_flags : [];
  const config = bindings.find(binding => binding.name === "OAUTH_CIMD_ENABLED");
  const vpc = bindings.filter(binding => binding.type === "vpc_network" || binding.name === "OAUTH_CIMD_EGRESS");
  const explicitOff = config?.type === "plain_text" && config.text === "0";
  const strictPublic = compatibilityFlags.includes(STRICT_PUBLIC_FLAG);
  const noPrivateEgress = vpc.length === 0;
  const safeClosed = explicitOff && strictPublic && noPrivateEgress;
  return {
    safeClosed,
    worker: WORKER,
    deploymentFlag: config?.type === "plain_text" ? config.text : "missing",
    strictPublicFetch: strictPublic,
    networkBindings: vpc.map(b => ({ name: b.name, type: b.type })),
    status: safeClosed ? "SAFE_CLOSED" : "RELEASE_GATE_FAILED",
    note: "Public-only fetch configuration is not equivalent to live DNS rebinding/SSRF penetration test evidence.",
  };
}

export async function auditCimdStaging({ accountId, token, getSettings } = {}) {
  assert.match(accountId || "", /^[a-f0-9]{32}$/u, "Cloudflare account ID required");
  assert.ok(typeof token === "string" && token.length > 5, "Cloudflare API token required");
  const fetchSettings = getSettings || async () => {
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
  };
  return assessCimdStaging(await fetchSettings());
}

async function main() {
  const result = await auditCimdStaging({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    token: process.env.CLOUDFLARE_API_TOKEN,
  });
  console.log("Staging CIMD egress audit: " + JSON.stringify(result));
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY,
      "\n## CIMD Public-Only Network Gate\n"
      + "- Staging release flag: `" + result.deploymentFlag + "`\n"
      + "- Cloudflare global fetch strictly public: `" + result.strictPublicFetch + "`\n"
      + "- VPC/private egress bindings: `" + result.networkBindings.length + "`\n"
      + "- Result: **" + result.status + "**\n"
      + "- Pending: live negative DNS rebinding tests and positive CIMD metadata discovery.\n");
  }
  if (!result.safeClosed) {
    throw new Error(
      "Staging CIMD release gate requires flag=0, global_fetch_strictly_public and no VPC egress",
    );
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
