import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const prepareSmoke = new URL("../../../infra/scripts/prepare-staging-smoke.mjs", import.meta.url);
const cleanupSmoke = new URL("../../../infra/scripts/cleanup-staging-smoke.mjs", import.meta.url);
const eventingSmoke = new URL("../../../infra/scripts/verify-staging-eventing.mjs", import.meta.url);
const waitApacProbe = new URL("../../../infra/scripts/wait-staging-apac-probe.mjs", import.meta.url);
const scripts = [prepareSmoke, cleanupSmoke, eventingSmoke, waitApacProbe];
const apacWorkflow = new URL("../../../.github/workflows/apac-performance-gate.yml", import.meta.url);
const apacProbeConfig = new URL("../../../infra/performance-probe/wrangler.jsonc", import.meta.url);

test("authenticated staging smoke scripts remain syntax-valid and staging-only", () => {
  for (const url of scripts) {
    const filename = fileURLToPath(url);
    const result = spawnSync(process.execPath, ["--check", filename], { encoding: "utf8" });
    assert.equal(result.status, 0, `${filename} failed node --check: ${result.stderr || result.stdout}`);

    const source = readFileSync(filename, "utf8");
    assert.match(source, /staging/iu, `${filename} must remain explicitly staging-scoped`);
    assert.doesNotMatch(source, /--env[\s"',]+production/u, `${filename} must never target Wrangler production`);
    assert.doesNotMatch(source, /core\.aisr\.online/u, `${filename} must never target the production Core hostname`);
    assert.doesNotMatch(source, /auth\.aisr\.online/u, `${filename} must never target the production Identity hostname`);
  }
});

test("staging bootstrap masks ephemeral credentials before job export", () => {
  const source = readFileSync(fileURLToPath(prepareSmoke), "utf8");
  assert.match(source, /::add-mask::/u);
  assert.match(source, /GITHUB_ENV/u);
  assert.match(source, /15 \* 60 \* 1000/u, "service PAT should retain a bounded staging-only lifetime");
  assert.match(source, /application_model_access/u, "smoke app model authorization must be explicit");
});

test("staging Eventing verifier proves the real signed delivery path through one shared Webhook Endpoint", () => {
  const source = readFileSync(fileURLToPath(eventingSmoke), "utf8");

  assert.match(source, /EVENT_SUBSCRIBER_ACCESS_DENIED/u, "smoke must prove subscriber Data Grant denial before authorization and after revocation");
  assert.match(source, /record\.created/u, "smoke must exercise a real domain event rather than Endpoint test-send only");
  assert.match(source, /EVENTING_SIGNING_SECRET/u, "smoke sink must verify the LifeSpace HMAC signing secret");
  assert.match(source, /\/api\/v1\/webhook-endpoints/u, "smoke must create and manage the shared Webhook Endpoint");
  assert.match(source, /endpointId[\s\S]*modelKey:\s*"event"[\s\S]*eventTypes:\s*\["record\.created"\]/u, "subscription must be a model/event filter attached to the Endpoint");
  assert.match(source, /\/api\/v1\/webhook-endpoints\/\$\{encodeURIComponent\(endpointId\)\}\/test/u, "test-send must be Endpoint-scoped");
  assert.match(source, /\/api\/v1\/webhook-endpoints\/\$\{encodeURIComponent\(endpointId\)\}\/deliveries/u, "delivery diagnostics must be Endpoint-scoped");
  assert.match(source, /endpoint\.test/u, "temporary sink must validate Endpoint test payload semantics");
  assert.match(source, /x-lifespace-webhook-endpoint-id/u, "temporary sink must validate the Endpoint delivery header");
  assert.match(source, /workers\/scripts/u, "smoke must create an ephemeral Cloudflare Worker receiver");
  assert.match(source, /workers\/domains/u, "smoke must attach an ephemeral Worker Custom Domain for Worker-to-Worker fetch correctness");
  assert.match(source, /eventing-smoke-staging-/u, "smoke hostname must remain visibly staging-scoped");
  assert.match(source, /temporary staging Custom Domain detach/u, "smoke must detach its temporary Custom Domain during cleanup");
  assert.match(source, /Webhook Endpoint delete/u, "smoke must delete its temporary Endpoint during cleanup");
  assert.match(source, /method:\s*"DELETE"/u, "smoke must delete temporary Cloudflare resources during cleanup");
  assert.match(source, /event mutation -> D1 outbox -> subscription filter -> shared Webhook Endpoint -> Cloudflare Queue -> HMAC Webhook Custom Domain/u);
  assert.match(source, /endpointTransportTestIndependentFromModelGrant:\s*true/u, "Endpoint transport/signature verification must remain independent from model Data Grants");
  assert.doesNotMatch(source, /event-subscriptions\/\$\{encodeURIComponent\(subscriptionId\)\}\/test/u, "test-send must not regress to subscription-scoped transport");
  assert.doesNotMatch(source, /\.workers\.dev/iu, "canonical Eventing smoke must not use workers.dev as a Worker-to-Worker Webhook target");
  assert.doesNotMatch(source, /webhook\.site|httpbin/iu, "staging acceptance must not depend on third-party Webhook collectors");
});

test("APAC performance gate resolves real staging D1 IDs before preparing smoke authority", () => {
  const source = readFileSync(fileURLToPath(apacWorkflow), "utf8");
  const resolveIndex = source.indexOf("node infra/scripts/resolve-staging-d1.mjs");
  const prepareIndex = source.indexOf("node infra/scripts/prepare-staging-smoke.mjs");

  assert.notEqual(resolveIndex, -1, "APAC gate must resolve staging D1 bindings in its ephemeral checkout");
  assert.notEqual(prepareIndex, -1, "APAC gate must prepare staging smoke authority");
  assert.ok(resolveIndex < prepareIndex, "staging D1 bindings must be resolved before prepare-staging-smoke uses wrangler d1 execute");
});

test("APAC performance gate proves the real POST /run path before timed benchmark samples", () => {
  const source = readFileSync(fileURLToPath(apacWorkflow), "utf8");
  const waitIndex = source.indexOf("node infra/scripts/wait-staging-apac-probe.mjs");
  const benchmarkIndex = source.indexOf("node infra/scripts/verify-staging-apac-performance.mjs");

  assert.notEqual(waitIndex, -1, "APAC gate must wait for the actual benchmark route, not health alone");
  assert.notEqual(benchmarkIndex, -1, "APAC gate must run the timed benchmark");
  assert.ok(waitIndex < benchmarkIndex, "real APAC probe route readiness must converge before timed samples start");

  const waitSource = readFileSync(fileURLToPath(waitApacProbe), "utf8");
  assert.match(waitSource, /\/run/u, "readiness must exercise the same POST /run entry point used by the benchmark");
  assert.match(waitSource, /tasks\?limit=1/u, "readiness probe must use a read-only Core request");
});

test("APAC performance probe remains deployable on Workers Free", () => {
  const source = readFileSync(fileURLToPath(apacProbeConfig), "utf8");
  const config = JSON.parse(source);

  assert.equal(config.workers_dev, true);
  assert.deepEqual(config.placement, { region: "aws:ap-southeast-1" });
  assert.equal(config.limits, undefined, "Workers Free must use platform-default CPU/subrequest limits instead of custom limits");
});
