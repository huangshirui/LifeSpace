// Read-only, early credential probe for owner-approved CIMD DNS test.
// No Worker preview, DNS mutation, or secret output. Requires a dedicated
// Zone-scoped Cloudflare API token (Zone Read + DNS Edit) for aisr.online.
import assert from "node:assert/strict";

const ZONE = "aisr.online";
const FIXTURE_PREFIX = "cimd-rebind-";
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CIMD_DNS_TEST_TOKEN;

assert.match(accountId || "", /^[a-f0-9]{32}$/u, "Cloudflare account ID missing");
assert.ok(typeof token === "string" && token.length > 8,
  "CIMD_DNS_TEST_TOKEN missing: configure a separate Staging environment secret");

async function get(path, label) {
  const response = await fetch("https://api.cloudflare.com/client/v4" + path, {
    redirect: "error", signal: AbortSignal.timeout(15000),
    headers: { authorization: "Bearer " + token },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.success !== true) {
    const code = data?.errors?.[0]?.code || "unknown";
    throw Error(label + " denied (HTTP " + response.status + ", Cloudflare code " + code
      + "). Check Staging CIMD_DNS_TEST_TOKEN: Zone → Zone → Read AND"
      + " Zone → DNS → Edit, restricted to aisr.online. No DNS records changed.");
  }
  return data.result;
}

try {
  const zones = await get("/zones?name=" + encodeURIComponent(ZONE), "Read DNS Zone");
  assert.ok(Array.isArray(zones) && zones.length === 1
    && zones[0].name === ZONE && zones[0].status === "active"
    && zones[0].account?.id === accountId, "Expected one active aisr.online zone in linked account");
  const zone = zones[0];
  assert.ok(Array.isArray(zone.name_servers) && zone.name_servers.length >= 2,
    "Two authoritative Cloudflare nameservers required");
  await get("/zones/" + encodeURIComponent(zone.id) + "/dns_records?name.startswith="
    + encodeURIComponent(FIXTURE_PREFIX) + "&per_page=1", "Read scoped DNS Records");
  console.log("PASS: read-only Cloudflare Zone and DNS records preflight");
  console.log("NOT VERIFIED: Zone DNS Edit permission; required for the subsequent owner-approved test");
} catch (error) {
  console.error("FAIL: " + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}
