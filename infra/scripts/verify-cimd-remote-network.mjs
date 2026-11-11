// Direct-owner, Staging-only remote Cloudflare network probes.
// A Wrangler Remote Dev preview is temporary and contains no DB, Secret,
// Service, Route or VPC bindings. It never touches Identity Staging config,
// Production, private Tunnel/Mesh/WAN or arbitrary user-provided URLs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { runControlledDnsFlip } from "./cimd-controlled-dns-flip.mjs";
import { appendFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

assert.match(process.env.CLOUDFLARE_ACCOUNT_ID || "", /^[a-f0-9]{32}$/,
  "Missing Cloudflare account ID");
assert.ok(process.env.CLOUDFLARE_API_TOKEN, "Missing protected Cloudflare API token");
const localBase = "http://127.0.0.1:8797";
const token = randomBytes(32).toString("hex");
const dnsFlipEnabled = process.env.CIMD_DNS_FLIP === "1";
const dnsFlipHost = dnsFlipEnabled
  ? "cimd-rebind-" + randomUUID().replaceAll("-", "") + ".aisr.online" : null;
const args = [
  "--dir", "apps/identity", "exec", "wrangler", "dev",
  "--remote", "--config", "../../infra/cimd-network-probe/wrangler.jsonc",
  "--ip", "127.0.0.1", "--port", "8797", "--var", `PROBE_TOKEN:${token}`,
  ...(dnsFlipHost ? ["--var", `REBIND_HOST:${dnsFlipHost}`] : []),
];
const child = spawn("pnpm", args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
  detached: true, env: { ...process.env, NO_COLOR: "1", CI: "true" } });
let recentLogs = "";
for (const stream of [child.stdout, child.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", chunk => {
    recentLogs = (recentLogs + String(chunk)).slice(-12000);
  });
}
let exitCode = null;
child.on("exit", code => { exitCode = code; });

async function tryFetch(path, options = {}) {
  return fetch(localBase + path, { ...options, signal: AbortSignal.timeout(20000) });
}
async function waitForPreview() {
  for (let i = 0; i < 65; ++i) {
    if (exitCode !== null) throw Error("Remote Wrangler preview exited prematurely");
    try {
      const res = await fetch(localBase + "/health", { signal: AbortSignal.timeout(1500) });
      if (res.ok && (await res.text()) === "ready") return;
    } catch { /* Remote preview may still be warming */ }
    await sleep(2000);
  }
  throw Error("Temporary Cloudflare Remote Preview did not become ready");
}

let failed = null;
try {
  await waitForPreview();
  const response = await tryFetch("/probe", {
    method: "POST", headers: { authorization: "Bearer " + token },
  });
  assert.equal(response.status, 200, "Remote probe returned non-success");
  const result = await response.json();
  assert.equal(result.fixtureMetadataOk, true,
    "Public HTTPS CIMD JSON fixture fetch/parse failed");
  assert.deepEqual(result.sameZone, { status: 200, issuerMatches: true },
    "Same-zone fetch did not route to public OAuth metadata");
  assert.equal(result.noPrivateSuccess, true,
    "A private/loopback destination returned HTTP 2xx (investigate immediately)");
  assert.equal(result.negatives.length, 5, "Unexpected missing negative probes");
  assert.equal(result.inFlightDnsRebindingProven, false,
    "No in-flight DNS rebinding test was executed; must not claim it passed");

  console.log("PASS: Cloudflare remote preview with strict-public runtime flag");
  console.log("PASS: public HTTPS CIMD metadata parsed from external fixture");
  console.log("PASS: same-zone fetch reaches Cloudflare public front door");
  for (const n of result.negatives) {
    console.log("NO-2XX: " + n.name + " outcome=" + n.outcome
      + (n.status === undefined ? "" : " status=" + n.status));
  }
  console.log("PASS: all 5 private/loopback probes produced no 2xx responses");
  console.log("NOT TESTED: in-flight DNS rebinding with controlled authoritative DNS");

  if (dnsFlipHost) {
    const result = await runControlledDnsFlip({
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      token: process.env.CLOUDFLARE_API_TOKEN,
      host: dnsFlipHost,
      previewUrl: localBase + "/dns-flip", authToken: token,
    });
    assert.equal(result.authoritativeFlipObserved, true);
    assert.equal(result.noPrivate2xxObserved, true);
    assert.equal(result.inFlightDnsRebindingProven, false);
    console.log("PASS: controlled authoritative DNS public-to-private change between requests");
    console.log("NOT PROVEN: in-flight DNS rebinding or actual remote edge resolved-IP selection");
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY,
      "\n## Live CIMD network reachability tests (temporary Cloudflare remote preview)\n"
      + "- Public metadata: PASS\n"
      + "- Same-zone strict-public routing: PASS\n"
      + "- Five fixed private/loopback network reachability probes: NO 2xx\n"
      + "- **In-flight DNS rebinding: NOT PROVEN** (single-connection or worker-resolved IP is not exposed)\n"
      + (dnsFlipHost ? "- Isolated authoritative A-record public→private transition: PASS; record deleted\n" : "")
      + "- Worker preview is ephemeral; no LifeSpace staging/production code or settings modified\n");
  }
} catch (error) {
  failed = error;
  console.error("FAIL: CIMD remote network probe: " + (error?.message ?? String(error)));
  console.error("Wrangler diagnostic (secrets redacted): "
    + recentLogs.replaceAll(token, "[REDACTED]").slice(-2000));
} finally {
  if (child.pid) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  }
}
if (failed) process.exitCode = 1;
