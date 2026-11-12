// The owner-dispatched canonical Staging workflow verifies a separately
// provisioned, isolated CIMD Node relay BEFORE changing Identity. No secrets
// or upstream response bodies are printed. No DNS edit credentials required.
import assert from "node:assert/strict";

const FLAG = process.env.LIFESPACE_CIMD_ENABLED || "0";
assert.ok(FLAG === "0" || FLAG === "1", "LIFESPACE_CIMD_ENABLED must be 0 or 1");
if (FLAG === "0") {
  console.log("CIMD release switch remains closed");
  process.exit(0);
}
const endpoint = process.env.OAUTH_CIMD_EGRESS_URL;
const secret = process.env.OAUTH_CIMD_EGRESS_SECRET;
assert.ok(typeof endpoint === "string" && endpoint.length <= 256, "Missing Staging CIMD egress endpoint");
const url = new URL(endpoint);
assert.ok(url.protocol === "https:" && url.href === endpoint && url.pathname === "/api/cimd"
  && !url.username && !url.password && !url.search && !url.hash && !url.port
  && /^[a-z0-9.-]+$/u.test(url.hostname) && url.hostname.includes(".")
  && /^[a-z]{2,63}$/u.test(url.hostname.split(".").at(-1))
  && !url.hostname.endsWith(".localhost") && !url.hostname.endsWith(".internal")
  && !url.hostname.endsWith(".local"), "Expected a deployment-owned public HTTPS CIMD relay /api/cimd");
assert.ok(/^[a-f0-9]{64}$/u.test(secret || ""), "Missing independent 32-byte hexadecimal relay secret");

const fixture = "https://cdn.jsdelivr.net/gh/huangshirui/LifeSpace@main/infra/cimd-network-probe/client.json";
async function request(clientId, authenticated = true) {
  return fetch(endpoint, {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(11000),
    headers: {"content-type": "application/json", ...(authenticated ? {authorization: "Bearer " + secret} : {})},
    body: JSON.stringify({client_id: clientId}),
  });
}
const forbidden = await request(fixture, false);
assert.equal(forbidden.status, 401, "Relay must deny unauthenticated callers");
await forbidden.body?.cancel();
console.log("PASS: unauthenticated relay access denied");
for (const clientId of [fixture, "https://chatgpt.com/oauth/client.json"]) {
  const result = await request(clientId);
  assert.equal(result.status, 200, "Relay must fetch real public CIMD JSON");
  const json = await result.json();
  assert.equal(json.client_id, clientId, "Relay returned a different metadata ID");
  assert.ok(Array.isArray(json.redirect_uris) && json.redirect_uris.length, "No public redirect URI");
  console.log("PASS: relay obtained public CIMD metadata: " + new URL(clientId).hostname);
}
for (const target of ["https://127.0.0.1/cimd-test", "https://127.0.0.1.sslip.io/cimd-test"]) {
  const result = await request(target);
  assert.equal(result.status, 400, "Relay must reject a private destination");
  await result.body?.cancel();
}
console.log("PASS: literal and DNS-to-private requests denied");
console.log("PASS: isolated CIMD relay preflight (actual deployed service); no DNS mutation");
