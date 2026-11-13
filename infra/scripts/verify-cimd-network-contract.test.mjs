import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");

test("temporary CIMD remote preview has strictly-public fetch and no persistent route or binding", () => {
  const config = JSON.parse(read("../cimd-network-probe/wrangler.jsonc"));
  assert.deepEqual(config.compatibility_flags, ["global_fetch_strictly_public"]);
  assert.equal(config.compatibility_date, "2026-08-08");
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  for (const banned of ["routes", "services", "vpc_networks", "r2_buckets", "d1_databases", "kv_namespaces", "durable_objects", "vars", "secrets"]) {
    assert.equal(config[banned], undefined, "Unexpected persistent / private probe binding: " + banned);
  }
});

test("public CIMD fixture pins exact external URL and safe callback", () => {
  const fixture = JSON.parse(read("../cimd-network-probe/client.json"));
  assert.equal(fixture.client_id,
    "https://cdn.jsdelivr.net/gh/huangshirui/LifeSpace@main/infra/cimd-network-probe/client.json");
  assert.deepEqual(fixture.redirect_uris, ["https://oauth-acceptance.example.org/callback"]);
  assert.deepEqual(fixture.response_types, ["code"]);
  assert.equal(fixture.token_endpoint_auth_method, "none");
});

test("remote probe never takes arbitrary target URLs or touches sensitive cloud metadata", () => {
  const src = read("../cimd-network-probe/worker.ts");
  const runner = read("verify-cimd-remote-network.mjs");
  assert.match(src, /request\.headers\.get\("authorization"\)/);
  assert.doesNotMatch(src, /\.searchParams\.get\(\s*["']url["']/);
  assert.doesNotMatch(src, /169\.254\.169\.254|metadata\.google|iam\/security-credentials/);
  assert.match(runner, /--remote/);
  assert.match(runner, /--var/);
  assert.match(runner, /NO-2XX/);
  assert.match(runner, /NOT TESTED: in-flight DNS rebinding/);
});


test("diagnostic-only preview uses fixed public targets and cannot enable DNS mutation",()=>{
  const src=read("../cimd-network-probe/worker.ts");
  const runner=read("verify-cimd-remote-network.mjs");
  const workflow=read("../../.github/workflows/staging-cimd-network.yml");
  assert.match(src,/path === "\/diagnostic"/);
  assert.match(src,/diagnose\(clientId,/);
  assert.match(src,/diagnose\("https:\/\/chatgpt\.com\/oauth\/client\.json",/);
  assert.match(src,/fetchClientMetadata\(id,tracedFetch\)/);
  assert.match(runner,/!diagnosticOnly \|\| !dnsFlipEnabled/);
  assert.match(runner,/--diagnostic-only/);
  assert.match(workflow,/diagnostic_only:/);
  assert.match(workflow,/--diagnostic-only/);
});

test("CIMD preview uses exact callback array-element equality, never substring matching", () => {
  const src = read("../cimd-network-probe/worker.ts");
  assert.doesNotMatch(src, /redirectUris\.includes\(/u);
  assert.equal((src.match(/redirectUris\.some\(uri => uri === /gu) ?? []).length, 3);
});
