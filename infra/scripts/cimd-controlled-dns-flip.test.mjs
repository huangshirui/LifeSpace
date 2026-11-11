import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = path => readFileSync(new URL(path, import.meta.url), "utf8");

test("DNS flip is owner-only, main-only, staging env and does not run on PR or deployment events", () => {
  const source = read("../../.github/workflows/staging-cimd-dns-flip.yml");
  assert.match(source, /workflow_dispatch:/);
  assert.match(source, /test "\$GITHUB_ACTOR" = "huangshirui"/);
  assert.match(source, /test "\$GITHUB_TRIGGERING_ACTOR" = "huangshirui"/);
  assert.match(source, /test "\$GITHUB_REF_NAME" = "main"/);
  assert.match(source, /environment: staging/);
  assert.doesNotMatch(source, /^\s+(push|pull_request|schedule|workflow_run|repository_dispatch):/mu);
  assert.match(source, /CIMD_DNS_FLIP: "1"/);
});

test("DNS flip is confined to random A record and protected cleanup path", () => {
  const source = read("cimd-controlled-dns-flip.mjs");
  assert.match(source, /cimd-rebind-\[a-f0-9\]\{32\}/);
  assert.match(source, /const ZONE = "aisr\.online"/);
  assert.match(source, /const INITIAL_IP = "1\.1\.1\.1"/);
  assert.match(source, /const PRIVATE_IP = "10\.255\.255\.254"/);
  assert.match(source, /const TTL = 120/);
  assert.match(source, /proxied: false/);
  assert.match(source, /\} finally \{/);
  assert.match(source, /current\?\.name === host/);
  assert.match(source, /"DELETE"/);
  assert.match(source, /temporary DNS A record deleted and its absence verified/);
  assert.match(source, /inFlightDnsRebindingProven: false/);
  assert.doesNotMatch(source, /169\.254\.169\.254|metadata\.google|iam\/security-credentials/);
});

test("DNS flip Worker never accepts arbitrary request URL or returns fetched response body", () => {
  const source = read("../cimd-network-probe/worker.ts");
  assert.match(source, /path === "\/dns-flip"/);
  assert.match(source, /REBIND_HOST/);
  assert.match(source, /cimd-rebind-\[a-f0-9\]\{32\}/);
  assert.doesNotMatch(source, /request\.json\(\)/);
  assert.doesNotMatch(source, /request\.headers\.get\("x-target-url"\)/);
  assert.match(source, /Never relay remote body or headers/);
});
