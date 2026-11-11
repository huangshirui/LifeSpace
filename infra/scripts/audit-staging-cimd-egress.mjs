// Read-only Cloudflare staging CIMD egress safety preflight.
// IMPORTANT: neither a VPC binding nor a Gateway policy is sufficient proof
// of connection-time protection against private routes or DNS rebinding.
// This preflight reports safe *closure*. Never claim open-CIMD acceptance.
//
// No create/update/delete Cloudflare APIs. No Production reads/writes.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const WORKER = "lifespace-identity-staging";

export function assessCimdStaging({ bindings = [], gatewayRules = null }) {
  const flag = bindings.find(b => b.name === "OAUTH_CIMD_ENABLED");
  const egress = bindings.find(b => b.name === "OAUTH_CIMD_EGRESS");
  const isEnabled = flag?.type === "plain_text" && flag.text === "1";
  const policyRules = Array.isArray(gatewayRules) ? gatewayRules : [];
  const networkBlocks = policyRules.filter(rule =>
    rule.enabled === true && rule.action === "block"
    && Array.isArray(rule.filters) && rule.filters.includes("l4")
    && typeof rule.traffic === "string" && rule.traffic.includes("net.dst.ip"));
  const dormantBlocks = policyRules.filter(rule =>
    rule.enabled === false && rule.action === "block"
    && Array.isArray(rule.filters) && rule.filters.includes("l4")
    && typeof rule.traffic === "string" && rule.traffic.includes("net.dst.ip"));
  // Binding presence does not attest Gateway policy correctness, including
  // destination IP *at actual connection time* or DNS rebinding protection.
  // Until independent negative-network acceptance exists, no staging Worker
  // should have an active CIMD egress binding.
  const safeClosed = !isEnabled && !egress;
  const code = egress
    ? "EGRESS_ATTACHED_WITHOUT_NETWORK_SECURITY_ATTESTATION"
    : isEnabled
      ? "CIMD_DEPLOYMENT_FLAG_NOT_CLOSED"
      : "SAFE_CLOSED";
  return {
    safeClosed,
    code,
    worker: WORKER,
    deploymentFlag: flag?.type === "plain_text" ? flag.text : "missing",
    egressBinding: egress ? { name: egress.name, type: egress.type } : null,
    gatewayNetworkDenyCount: networkBlocks.length,
    gatewayDisabledNetworkDenyCount: dormantBlocks.length,
    gatewayRulesReadable: gatewayRules !== null,
    warning: "No Gateway ruleset or VPC binding alone proves DNS rebinding safety; require independent connection-time negative tests and authorized release.",
  };
}

async function cfGet(accountId, token, path) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  const json = await response.json().catch(() => null);
  if (!response.ok || json?.success !== true) {
    throw new Error(`Cloudflare read-only API failed: ${path} HTTP ${response.status}`);
  }
  return json.result;
}

export async function auditCimdStaging({ accountId, token, fetchSettings, fetchGatewayRules } = {}) {
  assert.match(accountId || "", /^[a-f0-9]{32}$/u, "Cloudflare account ID required");
  assert.ok(typeof token === "string" && token.length > 5, "Cloudflare API token required");
  const getSettings = fetchSettings
    || (() => cfGet(accountId, token, `/workers/scripts/${WORKER}/settings`));
  const getGateway = fetchGatewayRules
    || (() => cfGet(accountId, token, "/gateway/rules"));
  const settings = await getSettings();
  let gatewayRules = null;
  let gatewayReadError = null;
  try {
    gatewayRules = await getGateway();
    if (!Array.isArray(gatewayRules)) gatewayReadError = "Gateway policy list not an array";
  } catch {
    // Gateway API permission is not necessary for reporting a safely closed
    // feature. Presence of a binding never passes regardless of this read.
    gatewayReadError = "Gateway policy list not readable with current token";
  }
  const result = assessCimdStaging({
    bindings: settings?.bindings,
    gatewayRules: Array.isArray(gatewayRules) ? gatewayRules : null,
  });
  return { ...result, gatewayReadError };
}

async function main() {
  const result = await auditCimdStaging({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    token: process.env.CLOUDFLARE_API_TOKEN,
  });
  console.log("Staging CIMD egress audit: " + JSON.stringify(result));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(process.env.GITHUB_STEP_SUMMARY,
      "\n## CIMD Staging Egress Release Gate\n"
      + "- Result: **" + (result.safeClosed ? "SAFE_CLOSED" : "NOT_READY") + "**\n"
      + "- Deployment flag: `" + result.deploymentFlag + "`\n"
      + "- Egress attached: `" + Boolean(result.egressBinding) + "`\n"
      + "- Active Gateway destination-IP block rules (not proof of DNS rebinding safety): "
      + result.gatewayNetworkDenyCount + "\n"
      + "- Dormant destination-IP block rules: " + result.gatewayDisabledNetworkDenyCount + "\n"
      + "- Explicit scope: no live SSRF test and no Production acceptance.\n");
  }
  if (!result.safeClosed) {
    throw new Error("CIMD must remain disabled and unbound until private-IP/DNS-rebinding egress proof is approved");
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL("file://" + process.argv[1], import.meta.url))) {
  await main();
}
